/**
 * 中奖码管家 — app.js (GitHub 存储版)
 * 图片存储在 GitHub 仓库，元数据存在 data/index.json
 */

// ── Config Storage Keys ─────────────────────────────────
const CFG_KEY  = 'qrm_github_config';
const DATA_FILE = 'data/index.json';
const IMG_DIR   = 'images';

// ── State ───────────────────────────────────────────────
let cfg = null;           // { owner, repo, token }
let qrList = [];
let currentFilter = 'all';
let modalIndex = -1;
let isSyncing = false;

// ── GitHub API helpers ──────────────────────────────────
async function ghFetch(path, opts = {}) {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `token ${cfg.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {})
    }
  });
  return res;
}

// Get file (returns { content (base64), sha } or null)
async function ghGetFile(filePath) {
  const res = await ghFetch(`/contents/${filePath}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json();
}

// Create or update file
async function ghPutFile(filePath, base64Content, message, sha) {
  const body = { message, content: base64Content };
  if (sha) body.sha = sha;
  const res = await ghFetch(`/contents/${filePath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub API error: ${res.status}`);
  }
  return res.json();
}

// Delete file
async function ghDeleteFile(filePath, message, sha) {
  const res = await ghFetch(`/contents/${filePath}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha })
  });
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub API error: ${res.status}`);
  }
}

// ── Data Sync ────────────────────────────────────────────
async function loadFromGitHub() {
  setSyncStatus('syncing', '⏳ 加载中…');
  try {
    const file = await ghGetFile(DATA_FILE);
    if (file) {
      const json = atob(file.content.replace(/\n/g, ''));
      qrList = JSON.parse(json);
    } else {
      qrList = [];
    }
    setSyncStatus('ok', '✓ 已同步');
    renderGrid();
  } catch(e) {
    setSyncStatus('error', '✗ 加载失败');
    showToast('加载数据失败：' + e.message, 'error');
  }
}

async function saveToGitHub() {
  if (isSyncing) return;
  isSyncing = true;
  setSyncStatus('syncing', '⏫ 保存中…');
  try {
    // Strip dataUrl before saving metadata (keep image path reference only)
    const meta = qrList.map(q => ({
      id: q.id,
      name: q.name,
      path: q.path,
      used: q.used,
      addedAt: q.addedAt,
      usedAt: q.usedAt || null
    }));
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(meta, null, 2))));

    // Get current sha if exists
    let sha;
    const existing = await ghGetFile(DATA_FILE);
    if (existing) sha = existing.sha;

    await ghPutFile(DATA_FILE, content, '📊 update index', sha);
    setSyncStatus('ok', '✓ 已同步');
  } catch(e) {
    setSyncStatus('error', '✗ 保存失败');
    showToast('保存失败：' + e.message, 'error');
  } finally {
    isSyncing = false;
  }
}

function setSyncStatus(type, text) {
  const el = document.getElementById('sync-status');
  el.className = 'sync-status' + (type !== 'ok' ? ' ' + type : '');
  el.textContent = text;
}

// Image: upload to GitHub, returns raw URL
async function uploadImageToGitHub(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const base64 = e.target.result.split(',')[1];
        const ext = file.name.split('.').pop().toLowerCase() || 'jpg';
        const timestamp = Date.now();
        const rand = Math.random().toString(36).slice(2, 7);
        const filename = `${timestamp}_${rand}.${ext}`;
        const filePath = `${IMG_DIR}/${filename}`;

        await ghPutFile(filePath, base64, `📷 add ${filename}`);

        // Raw URL for GitHub Pages or raw.githubusercontent.com
        const rawUrl = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/main/${filePath}`;
        resolve({ path: filePath, url: rawUrl });
      } catch(err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

// ── Config ───────────────────────────────────────────────
function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) cfg = JSON.parse(raw);
  } catch(e) { cfg = null; }
}

function saveConfig() {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

function clearConfig() {
  localStorage.removeItem(CFG_KEY);
  cfg = null;
}

// ── DOM refs ─────────────────────────────────────────────
const fileInput        = document.getElementById('file-input');
const uploadZone       = document.getElementById('upload-zone');
const uploadProgress   = document.getElementById('upload-progress');
const qrGrid           = document.getElementById('qr-grid');
const emptyState       = document.getElementById('empty-state');
const btnRandom        = document.getElementById('btn-random');
const btnClearUsed     = document.getElementById('btn-clear-used');
const filterBtns       = document.querySelectorAll('.filter-btn');

const setupSection     = document.getElementById('setup-section');
const setupPanel       = document.getElementById('setup-panel');
const inputOwner       = document.getElementById('input-owner');
const inputRepo        = document.getElementById('input-repo');
const inputToken       = document.getElementById('input-token');
const btnConnect       = document.getElementById('btn-connect');
const btnCreateRepo    = document.getElementById('btn-create-repo');

const connectedBar     = document.getElementById('connected-bar');
const connectedRepoName= document.getElementById('connected-repo-name');
const btnDisconnect    = document.getElementById('btn-disconnect');

const modalOverlay     = document.getElementById('modal-overlay');
const modalClose       = document.getElementById('modal-close');
const modalImg         = document.getElementById('modal-img');
const modalQrWrap      = document.getElementById('modal-qr-wrap');
const modalMeta        = document.getElementById('modal-meta');
const modalMarkBtn     = document.getElementById('modal-mark-btn');
const modalUnmarkBtn   = document.getElementById('modal-unmark-btn');
const modalPrev        = document.getElementById('modal-prev');
const modalNext        = document.getElementById('modal-next');
const modalPos         = document.getElementById('modal-pos');
const modalTitle       = document.getElementById('modal-title');

const statUnused       = document.getElementById('stat-unused');
const statUsed         = document.getElementById('stat-used');
const bannerRemind     = document.getElementById('banner-remind');
const bannerCount      = document.getElementById('banner-count');
const toastContainer   = document.getElementById('toast-container');

const confirmOverlay   = document.getElementById('confirm-overlay');
const confirmIcon      = document.getElementById('confirm-icon');
const confirmTitle     = document.getElementById('confirm-title');
const confirmMsg       = document.getElementById('confirm-msg');
const confirmOkBtn     = document.getElementById('confirm-ok');
const confirmCancelBtn = document.getElementById('confirm-cancel');

// ── UI State ─────────────────────────────────────────────
function showConnected() {
  setupSection.style.display = 'none';
  connectedBar.classList.remove('hidden');
  connectedRepoName.textContent = `${cfg.owner}/${cfg.repo}`;
}

function showSetup() {
  setupSection.style.display = '';
  connectedBar.classList.add('hidden');
  if (cfg) {
    inputOwner.value = cfg.owner || '';
    inputRepo.value  = cfg.repo  || '';
    inputToken.value = cfg.token || '';
  }
}

// ── Connect Flow ─────────────────────────────────────────
btnConnect.addEventListener('click', async () => {
  const owner = inputOwner.value.trim();
  const repo  = inputRepo.value.trim();
  const token = inputToken.value.trim();

  if (!owner || !repo || !token) {
    showToast('请填写所有字段', 'warn');
    return;
  }

  btnConnect.disabled = true;
  btnConnect.textContent = '🔍 验证中…';

  try {
    cfg = { owner, repo, token };
    // Test access
    const res = await ghFetch('');
    if (res.status === 404) {
      showToast(`仓库 ${owner}/${repo} 不存在，请先创建或点击"自动创建仓库"`, 'error');
      cfg = null;
      return;
    }
    if (res.status === 401) {
      showToast('Token 无效或权限不足，请检查', 'error');
      cfg = null;
      return;
    }
    if (!res.ok) {
      showToast(`连接失败 (${res.status})`, 'error');
      cfg = null;
      return;
    }

    saveConfig();
    showConnected();
    showToast('🎉 已连接到 GitHub 仓库！', 'success');
    await loadFromGitHub();
  } catch(e) {
    showToast('连接失败：' + e.message, 'error');
    cfg = null;
  } finally {
    btnConnect.disabled = false;
    btnConnect.textContent = '🔗 连接仓库';
  }
});

// Auto-create repo
btnCreateRepo.addEventListener('click', async () => {
  const owner = inputOwner.value.trim();
  const token = inputToken.value.trim();
  const repoName = inputRepo.value.trim() || 'my-qrcodes';

  if (!owner || !token) {
    showToast('请先填写用户名和 Token', 'warn');
    return;
  }

  btnCreateRepo.disabled = true;
  btnCreateRepo.textContent = '⏳ 创建中…';

  try {
    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: repoName,
        description: '🎫 中奖码管家 - 二维码存储仓库',
        private: false,
        auto_init: true
      })
    });

    if (res.status === 422) {
      // Repo already exists
      showToast(`仓库 ${repoName} 已存在，直接连接即可`, 'warn');
      inputRepo.value = repoName;
    } else if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `创建失败 (${res.status})`);
    } else {
      inputRepo.value = repoName;
      showToast(`✅ 仓库 ${repoName} 创建成功！点击"连接仓库"继续`, 'success');
    }
  } catch(e) {
    showToast('创建仓库失败：' + e.message, 'error');
  } finally {
    btnCreateRepo.disabled = false;
    btnCreateRepo.textContent = '✨ 自动创建仓库';
  }
});

btnDisconnect.addEventListener('click', async () => {
  const ok = await showConfirm('🔌', '断开 GitHub 连接', '本地将不再连接该仓库，数据仍保留在 GitHub。', '确认断开');
  if (!ok) return;
  clearConfig();
  qrList = [];
  renderGrid();
  showSetup();
  showToast('已断开连接');
});

// ── Upload ────────────────────────────────────────────────
uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  handleFiles(Array.from(e.dataTransfer.files));
});
fileInput.addEventListener('change', () => {
  handleFiles(Array.from(fileInput.files));
  fileInput.value = '';
});

async function handleFiles(files) {
  if (!cfg) { showToast('请先连接 GitHub 仓库', 'warn'); return; }
  const imgFiles = files.filter(f => f.type.startsWith('image/'));
  if (!imgFiles.length) { showToast('请选择图片文件', 'warn'); return; }

  uploadProgress.classList.add('show');
  uploadProgress.textContent = `⏫ 上传中 (0 / ${imgFiles.length})…`;

  let succeeded = 0;
  for (let i = 0; i < imgFiles.length; i++) {
    const file = imgFiles[i];
    uploadProgress.textContent = `⏫ 上传中 (${i + 1} / ${imgFiles.length})：${file.name}`;
    try {
      const { path, url } = await uploadImageToGitHub(file);
      const entry = {
        id: Date.now() + '_' + Math.random().toString(36).slice(2),
        name: file.name,
        path,
        url,
        used: false,
        addedAt: new Date().toLocaleString('zh-CN'),
        usedAt: null
      };
      qrList.unshift(entry);
      succeeded++;
    } catch(e) {
      showToast(`上传失败：${file.name} — ${e.message}`, 'error');
    }
  }

  uploadProgress.classList.remove('show');

  if (succeeded > 0) {
    await saveToGitHub();
    renderGrid();
    showToast(`✅ 已上传 ${succeeded} 张二维码到 GitHub`, 'success');
  }
}

// ── Filter ────────────────────────────────────────────────
filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderGrid();
  });
});

function getFiltered() {
  if (currentFilter === 'unused') return qrList.filter(q => !q.used);
  if (currentFilter === 'used')   return qrList.filter(q =>  q.used);
  return [...qrList];
}

// ── Render Grid ────────────────────────────────────────────
function renderGrid() {
  const list = getFiltered();
  qrGrid.innerHTML = '';
  updateStats();

  if (!list.length) {
    emptyState.classList.add('show');
    return;
  }
  emptyState.classList.remove('show');

  list.forEach((qr, idx) => {
    const card = document.createElement('div');
    card.className = 'qr-card' + (qr.used ? ' used' : '');
    card.dataset.id = qr.id;

    // Use url (GitHub raw) if available, fallback to dataUrl
    const imgSrc = qr.url || qr.dataUrl || '';

    card.innerHTML = `
      <div class="qr-img-wrap">
        <img src="${escAttr(imgSrc)}" alt="${escAttr(qr.name)}" loading="lazy" />
        <div class="used-overlay">
          <span class="used-badge">✓ 已使用</span>
        </div>
      </div>
      <div class="qr-info">
        <span class="qr-name" title="${escAttr(qr.name)}">${shortenName(qr.name)}</span>
        ${qr.used
          ? `<button class="qr-mark-btn mark-unused" data-id="${qr.id}">↩</button>`
          : `<button class="qr-mark-btn mark-used"   data-id="${qr.id}">✅</button>`
        }
      </div>
    `;

    card.querySelector('.qr-img-wrap').addEventListener('click', () => openModal(idx));
    card.querySelector('.qr-name').addEventListener('click',    () => openModal(idx));
    card.querySelector('.qr-mark-btn').addEventListener('click', e => {
      e.stopPropagation();
      toggleUsed(qr.id);
    });

    qrGrid.appendChild(card);
  });
}

function escAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function shortenName(name) {
  if (!name) return '未命名';
  const noExt = name.replace(/\.[^.]+$/, '');
  return noExt.length > 10 ? noExt.slice(0, 10) + '…' : noExt;
}

// ── Stats & Banner ─────────────────────────────────────────
function updateStats() {
  const unused = qrList.filter(q => !q.used).length;
  const used   = qrList.filter(q =>  q.used).length;
  statUnused.textContent = unused;
  statUsed.textContent   = used;
  if (unused > 0) {
    bannerRemind.classList.remove('hidden');
    bannerCount.textContent = unused;
  } else {
    bannerRemind.classList.add('hidden');
  }
}

// ── Toggle Used ────────────────────────────────────────────
async function toggleUsed(id) {
  const item = qrList.find(q => q.id === id);
  if (!item) return;
  item.used = !item.used;
  item.usedAt = item.used ? new Date().toLocaleString('zh-CN') : null;
  renderGrid();
  showToast(item.used ? '✅ 已标记为已使用' : '↩ 已撤销使用标记', item.used ? 'success' : '');

  if (modalOverlay.classList.contains('open')) {
    const list = getFiltered();
    const newIdx = list.findIndex(q => q.id === id);
    if (newIdx >= 0) { modalIndex = newIdx; renderModal(); }
    else closeModal();
  }

  await saveToGitHub();
}

// ── Random Pick ────────────────────────────────────────────
btnRandom.addEventListener('click', () => {
  const unused = qrList.filter(q => !q.used);
  if (!unused.length) { showToast('🎉 所有二维码都已使用！', 'warn'); return; }

  currentFilter = 'all';
  filterBtns.forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  renderGrid();

  const pick = unused[Math.floor(Math.random() * unused.length)];
  const list = getFiltered();
  const idx  = list.findIndex(q => q.id === pick.id);
  openModal(idx);
  showToast('🎲 已随机抽取一张待兑奖码！');

  setTimeout(() => {
    const card = qrGrid.querySelector(`[data-id="${pick.id}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('highlight-ring');
      setTimeout(() => card.classList.remove('highlight-ring'), 3200);
    }
  }, 100);
});

// ── Clear Used ─────────────────────────────────────────────
btnClearUsed.addEventListener('click', async () => {
  const usedItems = qrList.filter(q => q.used);
  if (!usedItems.length) { showToast('没有已使用的二维码', 'warn'); return; }

  const ok = await showConfirm(
    '🗑',
    '清除已使用的二维码',
    `将从 GitHub 仓库删除 ${usedItems.length} 张已使用的二维码图片，此操作不可撤销。`,
    '确认删除'
  );
  if (!ok) return;

  setSyncStatus('syncing', '⏳ 删除中…');

  // Delete image files from GitHub
  for (const item of usedItems) {
    if (item.path) {
      try {
        const file = await ghGetFile(item.path);
        if (file) await ghDeleteFile(item.path, `🗑 delete ${item.path}`, file.sha);
      } catch(e) {
        // Ignore individual delete errors
      }
    }
  }

  qrList = qrList.filter(q => !q.used);
  await saveToGitHub();
  renderGrid();
  showToast(`🗑 已删除 ${usedItems.length} 张已使用的二维码`, 'success');
});

// ── Modal ──────────────────────────────────────────────────
function openModal(idx) {
  const list = getFiltered();
  if (!list.length) return;
  modalIndex = Math.max(0, Math.min(idx, list.length - 1));
  renderModal();
  modalOverlay.classList.add('open');
}
function closeModal() { modalOverlay.classList.remove('open'); }

function renderModal() {
  const list = getFiltered();
  if (!list.length) { closeModal(); return; }
  const qr = list[modalIndex];
  if (!qr) return;

  const imgSrc = qr.url || qr.dataUrl || '';
  modalImg.src = imgSrc;
  modalImg.alt = qr.name;
  modalTitle.textContent = qr.used ? '🔒 已使用' : '🎫 查看二维码';

  if (qr.used) {
    modalQrWrap.classList.add('used');
    modalMarkBtn.style.display   = 'none';
    modalUnmarkBtn.style.display = '';
  } else {
    modalQrWrap.classList.remove('used');
    modalMarkBtn.style.display   = '';
    modalUnmarkBtn.style.display = 'none';
  }

  const usedLine = qr.used && qr.usedAt ? `<br>使用时间：${qr.usedAt}` : '';
  modalMeta.innerHTML = `<strong>${escAttr(qr.name)}</strong><br>上传时间：${qr.addedAt}${usedLine}`;

  modalPos.textContent = `${modalIndex + 1} / ${list.length}`;
  modalPrev.disabled = (modalIndex === 0);
  modalNext.disabled = (modalIndex === list.length - 1);
}

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', e => {
  if (!modalOverlay.classList.contains('open')) return;
  if (e.key === 'Escape')      closeModal();
  if (e.key === 'ArrowLeft')   navigate(-1);
  if (e.key === 'ArrowRight')  navigate(1);
});

function navigate(dir) {
  const list = getFiltered();
  const next = modalIndex + dir;
  if (next < 0 || next >= list.length) return;
  modalIndex = next;
  renderModal();
}
modalPrev.addEventListener('click', () => navigate(-1));
modalNext.addEventListener('click', () => navigate(1));

modalMarkBtn.addEventListener('click', () => {
  const qr = getFiltered()[modalIndex];
  if (qr) toggleUsed(qr.id);
});
modalUnmarkBtn.addEventListener('click', () => {
  const qr = getFiltered()[modalIndex];
  if (qr) toggleUsed(qr.id);
});

// Touch swipe
let touchStartX = 0;
document.getElementById('modal-qr-wrap').addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
}, { passive: true });
document.getElementById('modal-qr-wrap').addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 50) navigate(dx < 0 ? 1 : -1);
}, { passive: true });

// ── Custom Confirm ─────────────────────────────────────────
let confirmResolve = null;

function showConfirm(icon, title, msg, okLabel = '确认') {
  return new Promise(resolve => {
    confirmResolve = resolve;
    confirmIcon.textContent = icon;
    confirmTitle.textContent = title;
    confirmMsg.textContent = msg;
    confirmOkBtn.textContent = okLabel;
    confirmOverlay.classList.add('open');
  });
}

confirmOkBtn.addEventListener('click', () => {
  confirmOverlay.classList.remove('open');
  if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
});
confirmCancelBtn.addEventListener('click', () => {
  confirmOverlay.classList.remove('open');
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
});
confirmOverlay.addEventListener('click', e => {
  if (e.target === confirmOverlay) {
    confirmOverlay.classList.remove('open');
    if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
  }
});

// ── Toast ──────────────────────────────────────────────────
function showToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ── Init ───────────────────────────────────────────────────
loadConfig();
if (cfg) {
  showConnected();
  loadFromGitHub();
} else {
  showSetup();
  renderGrid();
}

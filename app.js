/**
 * 中奖码管家 — app.js (Gitee 存储版)
 * 图片存储在 Gitee 仓库，raw.gitee.com 直链全端可见
 * 删除=软删除进回收站，7天后彻底删除
 */

// ── Constants ────────────────────────────────────────────
const CFG_KEY    = 'qrm_gitee_config';
const DATA_FILE  = 'data/index.json';
const TRASH_FILE = 'data/trash.json';
const IMG_DIR    = 'images';
const TRASH_DAYS = 7;

// ── State ────────────────────────────────────────────────
let cfg = null;          // { owner, repo, token }
let qrList   = [];       // active qr codes
let trashList = [];      // soft-deleted qr codes
let currentFilter  = 'all';
let currentTab     = 'main';   // 'main' | 'trash'
let modalIndex     = -1;
let modalContext   = 'main';   // which tab the modal opened from
let isSyncing      = false;

// ── Gitee API helpers ────────────────────────────────────
// Gitee REST API v5: https://gitee.com/api/v5
// Uses form-urlencoded (simple request, no CORS preflight needed)
function giteeBase() {
  return `https://gitee.com/api/v5/repos/${cfg.owner}/${cfg.repo}`;
}

async function giteeFetch(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${giteeBase()}${path}${sep}access_token=${encodeURIComponent(cfg.token)}`;
  return fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {})
    }
  });
}

// Encode file path for URL — preserve '/' separators
function encodePath(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

// GET file → { content (base64), sha } or null
async function giteeGetFile(filePath) {
  const res = await giteeFetch(`/contents/${encodePath(filePath)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gitee API ${res.status}`);
  return res.json();
}

// Create or update file (uses form data, not JSON — avoids CORS preflight)
async function giteePutFile(filePath, base64Content, message, sha) {
  const params = new URLSearchParams();
  params.append('access_token', cfg.token);
  params.append('content', base64Content);
  params.append('message', message);
  if (sha) params.append('sha', sha);
  params.append('branch', 'master');

  const method = sha ? 'PUT' : 'POST';
  const res = await fetch(`${giteeBase()}/contents/${encodePath(filePath)}`, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Gitee ${method} ${res.status}`);
  }
  return res.json();
}

// Delete file
async function giteeDeleteFile(filePath, message, sha) {
  const params = new URLSearchParams();
  params.append('access_token', cfg.token);
  params.append('message', message);
  params.append('sha', sha);
  params.append('branch', 'master');

  const res = await fetch(`${giteeBase()}/contents/${encodePath(filePath)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Gitee DELETE ${res.status}`);
  }
}

// Build public raw image URL (no auth required, cross-device)
function rawUrl(filePath) {
  return `https://gitee.com/${cfg.owner}/${cfg.repo}/raw/master/${filePath}`;
}

// ── Data Sync ────────────────────────────────────────────
async function loadFromGitee() {
  setSyncStatus('syncing', '⏳ 加载中…');
  try {
    // Load active list
    const indexFile = await giteeGetFile(DATA_FILE);
    if (indexFile && indexFile.content) {
      try { qrList = JSON.parse(decodeBase64(indexFile.content)); } catch(e) { qrList = []; }
      if (!Array.isArray(qrList)) qrList = [];
    } else {
      qrList = [];
    }

    // Load trash
    const trashFile = await giteeGetFile(TRASH_FILE);
    if (trashFile && trashFile.content) {
      try { trashList = JSON.parse(decodeBase64(trashFile.content)); } catch(e) { trashList = []; }
      if (!Array.isArray(trashList)) trashList = [];
    } else {
      trashList = [];
    }

    // Auto-purge expired trash (>7 days)
    await autoPurgeTrash();

    setSyncStatus('ok', '✓ 已同步');
    renderCurrentTab();
  } catch(e) {
    setSyncStatus('error', '✗ 加载失败');
    showToast('加载数据失败：' + e.message, 'error');
  }
}

function decodeBase64(b64) {
  if (!b64) return '{}';
  // Gitee returns base64 with newlines
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
}

function encodeToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

async function saveIndexToGitee() {
  if (isSyncing) return;
  isSyncing = true;
  setSyncStatus('syncing', '⏫ 保存中…');
  try {
    const meta = qrList.map(q => ({
      id: q.id, name: q.name, path: q.path,
      used: q.used, addedAt: q.addedAt, usedAt: q.usedAt || null
    }));
    const content = encodeToBase64(JSON.stringify(meta, null, 2));
    const existing = await giteeGetFile(DATA_FILE);
    await giteePutFile(DATA_FILE, content, '📊 update index', existing?.sha);
    setSyncStatus('ok', '✓ 已同步');
  } catch(e) {
    setSyncStatus('error', '✗ 保存失败');
    showToast('保存失败：' + e.message, 'error');
  } finally {
    isSyncing = false;
  }
}

async function saveTrashToGitee() {
  const content = encodeToBase64(JSON.stringify(trashList, null, 2));
  const existing = await giteeGetFile(TRASH_FILE);
  await giteePutFile(TRASH_FILE, content, '🗑 update trash', existing?.sha);
}

// ── Trash: Auto-purge ────────────────────────────────────
async function autoPurgeTrash() {
  const now = Date.now();
  const expired = trashList.filter(q => {
    const deletedMs = new Date(q.deletedAt).getTime();
    return (now - deletedMs) >= TRASH_DAYS * 24 * 3600 * 1000;
  });
  if (!expired.length) return;

  // Physically delete expired image files
  for (const item of expired) {
    if (item.path) {
      try {
        const f = await giteeGetFile(item.path);
        if (f) await giteeDeleteFile(item.path, `♻️ purge expired ${item.path}`, f.sha);
      } catch(e) { /* ignore */ }
    }
  }

  trashList = trashList.filter(q => {
    const deletedMs = new Date(q.deletedAt).getTime();
    return (now - deletedMs) < TRASH_DAYS * 24 * 3600 * 1000;
  });
  await saveTrashToGitee();
}

// ── Config ───────────────────────────────────────────────
function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) cfg = JSON.parse(raw);
  } catch(e) { cfg = null; }
}
function saveConfig() { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }
function clearConfig() { localStorage.removeItem(CFG_KEY); cfg = null; }

// ── DOM refs ─────────────────────────────────────────────
const fileInput        = document.getElementById('file-input');
const uploadZone       = document.getElementById('upload-zone');
const uploadProgress   = document.getElementById('upload-progress');
const qrGrid           = document.getElementById('qr-grid');
const emptyState       = document.getElementById('empty-state');
const btnRandom        = document.getElementById('btn-random');
const btnDelete        = document.getElementById('btn-delete-used');
const filterBtns       = document.querySelectorAll('.filter-btn');

const setupSection     = document.getElementById('setup-section');
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
const modalDeleteBtn   = document.getElementById('modal-delete-btn');
const modalRestoreBtn  = document.getElementById('modal-restore-btn');
const modalPrev        = document.getElementById('modal-prev');
const modalNext        = document.getElementById('modal-next');
const modalPos         = document.getElementById('modal-pos');
const modalTitle       = document.getElementById('modal-title');

const statUnused       = document.getElementById('stat-unused');
const statUsed         = document.getElementById('stat-used');
const statTrash        = document.getElementById('stat-trash');
const bannerRemind     = document.getElementById('banner-remind');
const bannerCount      = document.getElementById('banner-count');
const toastContainer   = document.getElementById('toast-container');
const confirmOverlay   = document.getElementById('confirm-overlay');
const confirmIcon      = document.getElementById('confirm-icon');
const confirmTitle     = document.getElementById('confirm-title');
const confirmMsg       = document.getElementById('confirm-msg');
const confirmOkBtn     = document.getElementById('confirm-ok');
const confirmCancelBtn = document.getElementById('confirm-cancel');

const tabBtns          = document.querySelectorAll('.tab-btn');
const mainSection      = document.getElementById('main-section');
const trashSection     = document.getElementById('trash-section');
const trashGrid        = document.getElementById('trash-grid');
const trashEmpty       = document.getElementById('trash-empty');
const btnEmptyTrash    = document.getElementById('btn-empty-trash');

// ── Tabs ─────────────────────────────────────────────────
tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    renderCurrentTab();
  });
});

function renderCurrentTab() {
  if (currentTab === 'main') {
    mainSection.style.display  = '';
    trashSection.style.display = 'none';
    renderGrid();
  } else {
    mainSection.style.display  = 'none';
    trashSection.style.display = '';
    renderTrash();
  }
  updateStats();
}

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
  if (!owner || !repo || !token) { showToast('请填写所有字段', 'warn'); return; }

  btnConnect.disabled = true;
  btnConnect.textContent = '🔍 验证中…';

  try {
    cfg = { owner, repo, token };
    const res = await giteeFetch('');
    if (res.status === 404) {
      showToast(`仓库 ${owner}/${repo} 不存在，请先创建`, 'error'); cfg = null; return;
    }
    if (res.status === 401 || res.status === 403) {
      showToast('Token 无效或权限不足', 'error'); cfg = null; return;
    }
    if (!res.ok) {
      showToast(`连接失败 (${res.status})`, 'error'); cfg = null; return;
    }
    saveConfig();
    showConnected();
    showToast('🎉 已连接 Gitee 仓库！', 'success');
    await loadFromGitee();
  } catch(e) {
    showToast('连接失败：' + e.message, 'error'); cfg = null;
  } finally {
    btnConnect.disabled = false;
    btnConnect.textContent = '🔗 连接仓库';
  }
});

// Create repo via Gitee API
btnCreateRepo.addEventListener('click', async () => {
  const token = inputToken.value.trim();
  const repoName = inputRepo.value.trim() || 'my-qrcodes';
  if (!token) { showToast('请先填写 Token', 'warn'); return; }

  btnCreateRepo.disabled = true;
  btnCreateRepo.textContent = '⏳ 创建中…';
  try {
    const params = new URLSearchParams();
    params.append('access_token', token);
    params.append('name', repoName);
    params.append('description', '🎫 中奖码管家');
    params.append('private', 'false');
    params.append('auto_init', 'true');

    const res = await fetch(`https://gitee.com/api/v5/user/repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    if (res.status === 422) {
      showToast(`仓库已存在，直接连接即可`, 'warn');
    } else if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `创建失败 (${res.status})`);
    } else {
      const data = await res.json();
      inputOwner.value = data.owner?.login || inputOwner.value;
      inputRepo.value  = repoName;
      showToast(`✅ 仓库创建成功！点击"连接仓库"继续`, 'success');
    }
  } catch(e) {
    showToast('创建失败：' + e.message, 'error');
  } finally {
    btnCreateRepo.disabled = false;
    btnCreateRepo.textContent = '✨ 自动创建仓库';
  }
});

btnDisconnect.addEventListener('click', async () => {
  const ok = await showConfirm('🔌', '断开 Gitee 连接', '数据仍保留在 Gitee 仓库。', '确认断开');
  if (!ok) return;
  clearConfig(); qrList = []; trashList = [];
  renderCurrentTab(); showSetup(); showToast('已断开连接');
});

// ── Upload ────────────────────────────────────────────────
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('drag-over');
  handleFiles(Array.from(e.dataTransfer.files));
});
fileInput.addEventListener('change', () => { handleFiles(Array.from(fileInput.files)); fileInput.value = ''; });

async function handleFiles(files) {
  if (!cfg) { showToast('请先连接 Gitee 仓库', 'warn'); return; }
  const imgFiles = files.filter(f => f.type.startsWith('image/'));
  if (!imgFiles.length) { showToast('请选择图片文件', 'warn'); return; }

  uploadProgress.classList.add('show');
  let succeeded = 0;

  for (let i = 0; i < imgFiles.length; i++) {
    const file = imgFiles[i];
    uploadProgress.textContent = `⏫ 上传中 (${i + 1}/${imgFiles.length})：${file.name}`;
    try {
      const { path } = await uploadImageToGitee(file);
      qrList.unshift({
        id: Date.now() + '_' + Math.random().toString(36).slice(2),
        name: file.name,
        path,
        url: rawUrl(path),
        used: false,
        addedAt: new Date().toLocaleString('zh-CN'),
        usedAt: null
      });
      succeeded++;
    } catch(e) {
      showToast(`上传失败：${file.name} — ${e.message}`, 'error');
    }
  }

  uploadProgress.classList.remove('show');
  if (succeeded > 0) {
    await saveIndexToGitee();
    renderGrid();
    showToast(`✅ 已上传 ${succeeded} 张到 Gitee`, 'success');
  }
}

async function uploadImageToGitee(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const base64 = e.target.result.split(',')[1];
        const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
        const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const filePath = `${IMG_DIR}/${filename}`;
        await giteePutFile(filePath, base64, `📷 add ${filename}`, null);
        resolve({ path: filePath });
      } catch(err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

// ── Image URL helper ─────────────────────────────────────
function resolveImgUrl(qr) {
  if (qr.path && cfg) return rawUrl(qr.path);
  return qr.url || qr.dataUrl || '';
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

// ── Render: Main Grid ─────────────────────────────────────
function renderGrid() {
  const list = getFiltered();
  qrGrid.innerHTML = '';
  updateStats();
  if (!list.length) { emptyState.classList.add('show'); return; }
  emptyState.classList.remove('show');

  list.forEach((qr, idx) => {
    const card = document.createElement('div');
    card.className = 'qr-card' + (qr.used ? ' used' : '');
    card.dataset.id = qr.id;

    const imgSrc = resolveImgUrl(qr);
    card.innerHTML = `
      <div class="qr-img-wrap">
        <img src="${escAttr(imgSrc)}" alt="${escAttr(qr.name)}" loading="lazy"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
        <div class="img-fallback" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;flex-direction:column;gap:4px;color:#b0a89e;font-size:11px;background:#faf9f7;">
          <span style="font-size:28px">⏳</span><span>加载中…</span>
        </div>
        <div class="used-overlay"><span class="used-badge">✓ 已使用</span></div>
      </div>
      <div class="qr-info">
        <span class="qr-name" title="${escAttr(qr.name)}">${shortenName(qr.name)}</span>
        <span class="qr-actions">
          ${qr.used
            ? `<button class="qr-mark-btn mark-unused" data-id="${qr.id}" title="撤销">↩</button>`
            : `<button class="qr-mark-btn mark-used"   data-id="${qr.id}" title="标为已用">✅</button>`
          }
          <button class="qr-del-btn" data-id="${qr.id}" title="删除">🗑</button>
        </span>
      </div>
    `;

    card.querySelector('.qr-img-wrap').addEventListener('click', () => { modalContext = 'main'; openModal(idx); });
    card.querySelector('.qr-name').addEventListener('click', () => { modalContext = 'main'; openModal(idx); });
    card.querySelector('.qr-mark-btn').addEventListener('click', e => { e.stopPropagation(); toggleUsed(qr.id); });
    card.querySelector('.qr-del-btn').addEventListener('click', e => { e.stopPropagation(); deleteQR(qr.id); });
    qrGrid.appendChild(card);
  });
}

// ── Render: Trash Grid ────────────────────────────────────
function renderTrash() {
  trashGrid.innerHTML = '';
  updateStats();
  if (!trashList.length) { trashEmpty.classList.add('show'); return; }
  trashEmpty.classList.remove('show');

  trashList.forEach((qr, idx) => {
    const card = document.createElement('div');
    card.className = 'qr-card used';
    card.dataset.id = qr.id;

    const imgSrc = resolveImgUrl(qr);
    const deletedAt = qr.deletedAt ? new Date(qr.deletedAt) : null;
    const expireDate = deletedAt ? new Date(deletedAt.getTime() + TRASH_DAYS * 86400000) : null;
    const daysLeft = expireDate ? Math.max(0, Math.ceil((expireDate - Date.now()) / 86400000)) : '?';

    card.innerHTML = `
      <div class="qr-img-wrap">
        <img src="${escAttr(imgSrc)}" alt="${escAttr(qr.name)}" loading="lazy"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
        <div class="img-fallback" style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;flex-direction:column;gap:4px;color:#b0a89e;font-size:11px;background:#faf9f7;">
          <span style="font-size:28px">⏳</span><span>加载中…</span>
        </div>
        <div class="used-overlay"><span class="used-badge trash-badge">${daysLeft}天后删除</span></div>
      </div>
      <div class="qr-info">
        <span class="qr-name" title="${escAttr(qr.name)}">${shortenName(qr.name)}</span>
        <span class="qr-actions">
          <button class="qr-mark-btn mark-unused restore-btn" data-id="${qr.id}" title="恢复">↩ 恢复</button>
          <button class="qr-del-btn perm-del-btn" data-id="${qr.id}" title="彻底删除">✕</button>
        </span>
      </div>
    `;

    card.querySelector('.qr-img-wrap').addEventListener('click', () => { modalContext = 'trash'; openTrashModal(idx); });
    card.querySelector('.restore-btn').addEventListener('click', e => { e.stopPropagation(); restoreQR(qr.id); });
    card.querySelector('.perm-del-btn').addEventListener('click', e => { e.stopPropagation(); permanentDelete(qr.id); });
    trashGrid.appendChild(card);
  });
}

// ── Stats ─────────────────────────────────────────────────
function updateStats() {
  const unused = qrList.filter(q => !q.used).length;
  const used   = qrList.filter(q =>  q.used).length;
  statUnused.textContent = unused;
  statUsed.textContent   = used;
  statTrash.textContent  = trashList.length;
  bannerRemind.classList.toggle('hidden', unused === 0);
  bannerCount.textContent = unused;
}

// ── Toggle Used ────────────────────────────────────────────
async function toggleUsed(id) {
  const item = qrList.find(q => q.id === id);
  if (!item) return;
  item.used  = !item.used;
  item.usedAt = item.used ? new Date().toLocaleString('zh-CN') : null;
  renderGrid();
  showToast(item.used ? '✅ 已标记为已使用' : '↩ 已撤销', item.used ? 'success' : '');
  if (modalOverlay.classList.contains('open') && modalContext === 'main') {
    const list = getFiltered();
    const ni = list.findIndex(q => q.id === id);
    ni >= 0 ? (modalIndex = ni, renderModal()) : closeModal();
  }
  await saveIndexToGitee();
}

// ── Delete (soft) ─────────────────────────────────────────
async function deleteQR(id) {
  const item = qrList.find(q => q.id === id);
  if (!item) return;

  const ok = await showConfirm('🗑', '移入回收站', `"${shortenName(item.name)}" 将移入回收站，${TRASH_DAYS}天后自动彻底删除。`, '确认删除');
  if (!ok) return;

  // Move to trash
  item.deletedAt = new Date().toISOString();
  trashList.unshift(item);
  qrList = qrList.filter(q => q.id !== id);

  if (modalOverlay.classList.contains('open')) closeModal();

  try {
    setSyncStatus('syncing', '⏳ 同步中…');
    await saveIndexToGitee();
    await saveTrashToGitee();
    setSyncStatus('ok', '✓ 已同步');
  } catch(e) {
    showToast('同步失败：' + e.message, 'error');
  }

  renderCurrentTab();
  showToast('🗑 已移入回收站', 'success');
}

// ── Restore ───────────────────────────────────────────────
async function restoreQR(id) {
  const item = trashList.find(q => q.id === id);
  if (!item) return;

  // Remove deletedAt, restore to active
  delete item.deletedAt;
  item.used = false; item.usedAt = null; // reset used state on restore
  qrList.unshift(item);
  trashList = trashList.filter(q => q.id !== id);

  if (modalOverlay.classList.contains('open')) closeModal();

  try {
    setSyncStatus('syncing', '⏳ 同步中…');
    await saveIndexToGitee();
    await saveTrashToGitee();
    setSyncStatus('ok', '✓ 已同步');
  } catch(e) {
    showToast('同步失败：' + e.message, 'error');
  }

  renderCurrentTab();
  showToast('↩ 已从回收站恢复', 'success');
}

// ── Permanent delete ──────────────────────────────────────
async function permanentDelete(id) {
  const item = trashList.find(q => q.id === id);
  if (!item) return;
  const ok = await showConfirm('⚠️', '彻底删除', `"${shortenName(item.name)}" 将从 Gitee 永久删除，无法恢复！`, '彻底删除');
  if (!ok) return;

  trashList = trashList.filter(q => q.id !== id);

  try {
    setSyncStatus('syncing', '⏳ 删除中…');
    if (item.path) {
      const f = await giteeGetFile(item.path);
      if (f) await giteeDeleteFile(item.path, `♻️ perm delete ${item.path}`, f.sha);
    }
    await saveTrashToGitee();
    setSyncStatus('ok', '✓ 已同步');
  } catch(e) {
    showToast('删除失败：' + e.message, 'error');
  }

  renderTrash();
  showToast('♻️ 已彻底删除', 'success');
}

// ── Empty trash ───────────────────────────────────────────
btnEmptyTrash.addEventListener('click', async () => {
  if (!trashList.length) { showToast('回收站已空', 'warn'); return; }
  const ok = await showConfirm('⚠️', '清空回收站', `将永久删除回收站内全部 ${trashList.length} 张图片，无法恢复！`, '清空回收站');
  if (!ok) return;

  setSyncStatus('syncing', '⏳ 清空中…');
  for (const item of trashList) {
    if (item.path) {
      try {
        const f = await giteeGetFile(item.path);
        if (f) await giteeDeleteFile(item.path, `♻️ purge ${item.path}`, f.sha);
      } catch(e) { /* skip */ }
    }
  }
  trashList = [];
  await saveTrashToGitee();
  setSyncStatus('ok', '✓ 已同步');
  renderTrash();
  showToast('♻️ 回收站已清空', 'success');
});

// ── Random ────────────────────────────────────────────────
btnRandom.addEventListener('click', () => {
  const unused = qrList.filter(q => !q.used);
  if (!unused.length) { showToast('🎉 所有二维码都已使用！', 'warn'); return; }
  currentFilter = 'all';
  filterBtns.forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  renderGrid();
  const pick = unused[Math.floor(Math.random() * unused.length)];
  const list = getFiltered();
  const idx  = list.findIndex(q => q.id === pick.id);
  modalContext = 'main';
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

// ── Delete used button (move all used to trash) ───────────
btnDelete.addEventListener('click', async () => {
  const usedItems = qrList.filter(q => q.used);
  if (!usedItems.length) { showToast('没有已使用的二维码', 'warn'); return; }
  const ok = await showConfirm('🗑', '批量移入回收站', `将 ${usedItems.length} 张已使用的二维码移入回收站。`, '确认移入');
  if (!ok) return;

  const now = new Date().toISOString();
  usedItems.forEach(item => { item.deletedAt = now; trashList.unshift(item); });
  qrList = qrList.filter(q => !q.used);

  try {
    setSyncStatus('syncing', '⏳ 同步中…');
    await saveIndexToGitee();
    await saveTrashToGitee();
    setSyncStatus('ok', '✓ 已同步');
  } catch(e) {
    showToast('同步失败：' + e.message, 'error');
  }
  renderCurrentTab();
  showToast(`🗑 已将 ${usedItems.length} 张移入回收站`, 'success');
});

// ── Modal ─────────────────────────────────────────────────
function openModal(idx) {
  const list = getFilteredByContext();
  if (!list.length) return;
  modalIndex = Math.max(0, Math.min(idx, list.length - 1));
  renderModal();
  modalOverlay.classList.add('open');
}
function openTrashModal(idx) {
  modalContext = 'trash';
  openModal(idx);
}
function closeModal() { modalOverlay.classList.remove('open'); }

function getFilteredByContext() {
  return modalContext === 'trash' ? [...trashList] : getFiltered();
}

function renderModal() {
  const list = getFilteredByContext();
  if (!list.length) { closeModal(); return; }
  const qr = list[modalIndex];
  if (!qr) return;

  const imgSrc = resolveImgUrl(qr);
  modalImg.src  = imgSrc;
  modalImg.alt  = qr.name;

  const isTrash = modalContext === 'trash';
  modalTitle.textContent = isTrash ? '🗑 回收站' : (qr.used ? '🔒 已使用' : '🎫 查看二维码');
  modalQrWrap.classList.toggle('used', qr.used || isTrash);

  // Buttons
  modalMarkBtn.style.display    = (!isTrash && !qr.used) ? '' : 'none';
  modalUnmarkBtn.style.display  = (!isTrash && qr.used)  ? '' : 'none';
  modalDeleteBtn.style.display  = !isTrash ? '' : 'none';
  modalRestoreBtn.style.display = isTrash  ? '' : 'none';

  const usedLine = qr.used && qr.usedAt ? `<br>使用时间：${qr.usedAt}` : '';
  const trashLine = isTrash && qr.deletedAt
    ? `<br>删除时间：${new Date(qr.deletedAt).toLocaleString('zh-CN')}`
    : '';
  modalMeta.innerHTML = `<strong>${escAttr(qr.name)}</strong><br>上传时间：${qr.addedAt}${usedLine}${trashLine}`;

  modalPos.textContent = `${modalIndex + 1} / ${list.length}`;
  modalPrev.disabled = (modalIndex === 0);
  modalNext.disabled = (modalIndex === list.length - 1);
}

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', e => {
  if (!modalOverlay.classList.contains('open')) return;
  if (e.key === 'Escape')     closeModal();
  if (e.key === 'ArrowLeft')  navigate(-1);
  if (e.key === 'ArrowRight') navigate(1);
});

function navigate(dir) {
  const list = getFilteredByContext();
  const next = modalIndex + dir;
  if (next < 0 || next >= list.length) return;
  modalIndex = next;
  renderModal();
}
modalPrev.addEventListener('click', () => navigate(-1));
modalNext.addEventListener('click', () => navigate(1));

modalMarkBtn.addEventListener('click', () => {
  const qr = getFiltered()[modalIndex]; if (qr) toggleUsed(qr.id);
});
modalUnmarkBtn.addEventListener('click', () => {
  const qr = getFiltered()[modalIndex]; if (qr) toggleUsed(qr.id);
});
modalDeleteBtn.addEventListener('click', () => {
  const qr = getFiltered()[modalIndex]; if (qr) { closeModal(); deleteQR(qr.id); }
});
modalRestoreBtn.addEventListener('click', () => {
  const qr = trashList[modalIndex]; if (qr) restoreQR(qr.id);
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

// ── Custom Confirm ────────────────────────────────────────
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

// ── Toast ─────────────────────────────────────────────────
function showToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ── Helpers ───────────────────────────────────────────────
function setSyncStatus(type, text) {
  const el = document.getElementById('sync-status');
  el.className = 'sync-status' + (type !== 'ok' ? ' ' + type : '');
  el.textContent = text;
}
function escAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function shortenName(name) {
  if (!name) return '未命名';
  const noExt = name.replace(/\.[^.]+$/, '');
  return noExt.length > 10 ? noExt.slice(0, 10) + '…' : noExt;
}

// ── Init ──────────────────────────────────────────────────
loadConfig();
if (cfg) { showConnected(); loadFromGitee(); }
else { showSetup(); renderCurrentTab(); }

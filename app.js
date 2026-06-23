/**
 * 中奖码管家 — app.js v3 (纯文本解码版)
 *
 * 工作原理：
 * 1. 上传二维码图片 → jsQR 解码出文字内容
 * 2. 文字内容存到 Gitee data/index.json（纯文本，几KB）
 * 3. 查看时用 qrcode-generator 从文字重新绘制二维码到 Canvas
 * 4. 永不依赖图片文件，永不加载失败，全端同步！
 */

// ── Constants ────────────────────────────────────────────
const CFG_KEY    = 'qrm_gitee_config';
const DATA_FILE  = 'data/index.json';
const TRASH_FILE = 'data/trash.json';
const TRASH_DAYS = 7;
const QR_SIZE    = 5; // qrcode-generator module size (0=auto)
const QR_EC      = 'M'; // Error correction level: L/M/Q/H

// ── Hardcoded Gitee Config (所有入口自动连接，无需用户配置) ──
const BUILTIN_CFG = {
  owner: 'ad-deficiency-infant-calcium',
  repo:  'duijiang',
  token: '5bd3caacd8d17ef3544f928d231e2e8a'
};

// ── State ────────────────────────────────────────────────
let cfg = null;          // { owner, repo, token }
let qrList   = [];       // active qr codes
let trashList = [];      // soft-deleted qr codes
let currentFilter  = 'all';
let currentTab     = 'main';   // 'main' | 'trash'
let modalIndex     = -1;
let modalContext   = 'main';   // which tab the modal opened from
let isSyncing      = false;

// ── QR Code Generator Helper ─────────────────────────────
function generateQRCanvas(text, canvas, size) {
  const cellSize = size || 4;
  // Determine minimum version needed for the text
  const qr = qrcode(QR_EC, QR_SIZE);
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const canvasSize = Math.min(280, Math.max(120, count * cellSize));
  canvas.width = canvasSize;
  canvas.height = canvasSize;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvasSize, canvasSize);

  const modSize = canvasSize / count;

  // Draw white background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  // Draw black modules
  ctx.fillStyle = '#000000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect(c * modSize, r * modSize, modSize, modSize);
      }
    }
  }

  return canvas;
}

// ── QR Code Decoder (jsQR) ────────────────────────────────
function decodeQRFromImage(imageElement) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = imageElement.naturalWidth || imageElement.width || 200;
      canvas.height = imageElement.naturalHeight || imageElement.height || 200;
      ctx.drawImage(imageElement, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code && code.data) {
        resolve(code.data.trim());
      } else {
        reject(new Error('无法识别二维码'));
      }
    } catch(e) {
      reject(e);
    }
  });
}

function decodeQRFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => decodeQRFromImage(img).then(resolve).catch(reject);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = URL.createObjectURL(file);
  });
}

// ── Gitee API helpers ────────────────────────────────────
function giteeBase() {
  return `https://gitee.com/api/v5/repos/${cfg.owner}/${cfg.repo}`;
}

async function giteeFetch(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${giteeBase()}${path}${sep}access_token=${encodeURIComponent(cfg.token)}`;
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}) } });
}

function encodePath(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

async function giteeGetFile(filePath) {
  const res = await giteeFetch(`/contents/${encodePath(filePath)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gitee API ${res.status}`);
  return res.json();
}

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

// ── Data Sync ────────────────────────────────────────────
async function loadFromGitee() {
  setSyncStatus('syncing', '⏳ 加载中…');
  try {
    const indexFile = await giteeGetFile(DATA_FILE);
    if (indexFile && indexFile.content) {
      try { qrList = JSON.parse(decodeBase64(indexFile.content)); } catch(e) { qrList = []; }
      if (!Array.isArray(qrList)) qrList = [];
    } else {
      qrList = [];
    }

    const trashFile = await giteeGetFile(TRASH_FILE);
    if (trashFile && trashFile.content) {
      try { trashList = JSON.parse(decodeBase64(trashFile.content)); } catch(e) { trashList = []; }
      if (!Array.isArray(trashList)) trashList = [];
    } else {
      trashList = [];
    }

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
      id: q.id, name: q.name, content: q.content,
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

  trashList = trashList.filter(q => {
    const deletedMs = new Date(q.deletedAt).getTime();
    return (now - deletedMs) < TRASH_DAYS * 24 * 3600 * 1000;
  });
  await saveTrashToGitee();
}

// ── Config ───────────────────────────────────────────────
function loadConfig() {
  try { const raw = localStorage.getItem(CFG_KEY); if (raw) cfg = JSON.parse(raw); } catch(e) { cfg = null; }
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

// Setup panel elements (removed in auto-connect mode, guarded with null checks)
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
const modalQrCanvas    = document.getElementById('modal-qr-canvas');
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
  const setup = document.getElementById('setup-section');
  if (setup) setup.style.display = 'none';
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

// ── Connect Flow (auto-connect mode, guarded) ────────────
if (btnConnect) btnConnect.addEventListener('click', async () => {
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

if (btnCreateRepo) btnCreateRepo.addEventListener('click', async () => {
  const token = inputToken.value.trim();
  const repoName = inputRepo.value.trim() || 'my-qrcodes';
  if (!token) { showToast('请先填写 Token', 'warn'); return; }

  btnCreateRepo.disabled = true;
  btnCreateRepo.textContent = '⏳ 创建中…';
  try {
    const params = new URLSearchParams();
    params.append('access_token', token);
    params.append('name', repoName);
    params.append('description', '🎫 中奖码管家 — 二维码内容文本存储');
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

if (btnDisconnect) btnDisconnect.addEventListener('click', async () => {
  const ok = await showConfirm('🔌', '断开 Gitee 连接', '数据仍保留在 Gitee 仓库。', '确认断开');
  if (!ok) return;
  clearConfig(); qrList = []; trashList = [];
  renderCurrentTab(); showSetup(); showToast('已断开连接');
});

// ── Upload & Decode ──────────────────────────────────────
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
  let failedDecode = 0;

  for (let i = 0; i < imgFiles.length; i++) {
    const file = imgFiles[i];
    uploadProgress.textContent = `🔍 解码中 (${i + 1}/${imgFiles.length})：${file.name}`;
    try {
      const content = await decodeQRFromFile(file);
      if (!content) { failedDecode++; continue; }

      // Check duplicate
      if (qrList.some(q => q.content === content)) {
        showToast(`已跳过重复二维码：${file.name}`, 'warn');
        continue;
      }

      qrList.unshift({
        id: Date.now() + '_' + Math.random().toString(36).slice(2),
        name: file.name,
        content: content,
        used: false,
        addedAt: new Date().toLocaleString('zh-CN'),
        usedAt: null
      });
      succeeded++;
    } catch(e) {
      failedDecode++;
      showToast(`解码失败：${file.name} — ` + (e.message || '不是有效的二维码'), 'error');
    }
  }

  uploadProgress.classList.remove('show');

  if (succeeded > 0) {
    await saveIndexToGitee();
    renderGrid();
    showToast(`✅ 成功添加 ${succeeded} 张二维码${failedDecode > 0 ? `（${failedDecode} 张无法识别）` : ''}`, 'success');
  } else if (failedDecode > 0) {
    showToast(`${failedDecode} 张图片均无法识别为二维码`, 'error');
  }
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

    card.innerHTML = `
      <div class="qr-img-wrap">
        <canvas class="qr-canvas"></canvas>
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

    // Generate QR code on canvas
    const canvas = card.querySelector('.qr-canvas');
    generateQRCanvas(qr.content, canvas, 3);

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

    const deletedAt = qr.deletedAt ? new Date(qr.deletedAt) : null;
    const expireDate = deletedAt ? new Date(deletedAt.getTime() + TRASH_DAYS * 86400000) : null;
    const daysLeft = expireDate ? Math.max(0, Math.ceil((expireDate - Date.now()) / 86400000)) : '?';

    card.innerHTML = `
      <div class="qr-img-wrap">
        <canvas class="qr-canvas"></canvas>
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

    if (qr.content) generateQRCanvas(qr.content, card.querySelector('.qr-canvas'), 3);

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
  document.getElementById('tab-trash-badge').textContent = trashList.length;
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

  delete item.deletedAt;
  item.used = false; item.usedAt = null;
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
  const ok = await showConfirm('⚠️', '彻底删除', `"${shortenName(item.name)"} 将被永久删除，无法恢复！`, '彻底删除');
  if (!ok) return;

  trashList = trashList.filter(q => q.id !== id);
  try { await saveTrashToGitee(); } catch(e) {}
  renderTrash();
  showToast('♻️ 已彻底删除', 'success');
}

// ── Empty trash ───────────────────────────────────────────
btnEmptyTrash.addEventListener('click', async () => {
  if (!trashList.length) { showToast('回收站已空', 'warn'); return; }
  const ok = await showConfirm('⚠️', '清空回收站', `将永久删除回收站内全部 ${trashList.length} 张记录，无法恢复！`, '清空回收站');
  if (!ok) return;

  setSyncStatus('syncing', '⏳ 清空中…');
  trashList = [];
  try { await saveTrashToGitee(); } catch(e) {}
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

// ── Delete used button ────────────────────────────────────
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

  // Generate QR code on modal canvas
  generateQRCanvas(qr.content, modalQrCanvas, 4);

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
  const contentPreview = qr.content
    ? `<div class="modal-qr-content">📋 内容：${escAttr(qr.content)}</div>`
    : '';

  modalMeta.innerHTML =
    `<strong>${escAttr(qr.name)}</strong><br>上传时间：${qr.addedAt}${usedLine}${trashLine}${contentPreview}`;

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

// ── Init ──────────────────────────────────────────────────
// 自动使用内置配置连接，无需用户手动操作
cfg = BUILTIN_CFG;
showConnected();
loadFromGitee();

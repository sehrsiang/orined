'use strict';

/* ===================== API 請求 ===================== */
const API = {
  async request(path, { method = 'GET', body, auth = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = Auth.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }

    if (!res.ok) {
      const message = (data && data.error) || `請求失敗（${res.status}）`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get(p) { return this.request(p); },
  post(p, b) { return this.request(p, { method: 'POST', body: b }); },
  put(p, b) { return this.request(p, { method: 'PUT', body: b }); },
  patch(p, b) { return this.request(p, { method: 'PATCH', body: b }); },
  del(p) { return this.request(p, { method: 'DELETE' }); },
};

/* ===================== 登入狀態 ===================== */
const Auth = {
  getToken() { return localStorage.getItem('aurafit_token') || null; },
  getUser() {
    try { return JSON.parse(localStorage.getItem('aurafit_user') || 'null'); }
    catch (_) { return null; }
  },
  set(token, user) {
    localStorage.setItem('aurafit_token', token);
    localStorage.setItem('aurafit_user', JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem('aurafit_token');
    localStorage.removeItem('aurafit_user');
  },
  isLoggedIn() { return !!this.getToken(); },
  isAdmin() { const u = this.getUser(); return !!u && u.role === 'admin'; },
};

/* ===================== 購物車（存於 localStorage） ===================== */
const Cart = {
  key: 'aurafit_cart',
  items() {
    try { return JSON.parse(localStorage.getItem(this.key) || '[]'); }
    catch (_) { return []; }
  },
  save(items) {
    localStorage.setItem(this.key, JSON.stringify(items));
    window.dispatchEvent(new CustomEvent('cart:changed'));
  },
  add(product, { size = '', color = '', qty = 1 } = {}) {
    const items = this.items();
    const found = items.find(
      (i) => i.product_id === product.id && i.size === size && i.color === color
    );
    if (found) {
      found.qty += qty;
    } else {
      items.push({
        product_id: product.id,
        name: product.name,
        price: product.price,
        image: product.image,
        size,
        color,
        qty,
      });
    }
    this.save(items);
  },
  updateQty(index, qty) {
    const items = this.items();
    if (!items[index]) return;
    items[index].qty = Math.max(1, qty);
    this.save(items);
  },
  remove(index) {
    const items = this.items();
    items.splice(index, 1);
    this.save(items);
  },
  clear() { this.save([]); },
  count() { return this.items().reduce((n, i) => n + i.qty, 0); },
  total() { return this.items().reduce((n, i) => n + i.qty * i.price, 0); },
};

/* ===================== 共用工具 ===================== */
function formatMoney(n) {
  return 'NT$ ' + Number(n || 0).toLocaleString('zh-TW');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const ORDER_STATUS_LABEL = {
  pending: '待付款',
  paid: '已付款',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
};

function statusBadge(status) {
  return `<span class="badge badge-${status}">${ORDER_STATUS_LABEL[status] || status}</span>`;
}

let toastTimer = null;
function toast(message, type = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast show toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

/** 自訂確認視窗（不使用 window.confirm，避免在 iframe 中被瀏覽器封鎖）。 */
function confirmDialog(message, { title = '確認操作', okText = '確定刪除', danger = true } = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal" style="max-width:420px">
        <h3>${escapeHtml(title)}</h3>
        <p style="color:var(--muted);font-size:14px;line-height:1.7;margin:0 0 20px">${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-no>取消</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-dark'}" data-yes>${escapeHtml(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const finish = (value) => {
      mask.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') finish(false); };

    mask.addEventListener('click', (e) => {
      if (e.target === mask || e.target.hasAttribute('data-no')) finish(false);
      else if (e.target.hasAttribute('data-yes')) finish(true);
    });
    document.addEventListener('keydown', onKey);
  });
}

/* ===================== 網站名稱（品牌名）與樣式 ===================== */
const DEFAULT_SITE_NAME = 'AURAFIT';
const DEFAULT_BRAND_STYLE = 'duo';

/** 可選的品牌樣式（key 對應 CSS 的 .brand-style-<key>）。 */
const BRAND_STYLES = [
  { key: 'duo', label: '雙色（前深後金）' },
  { key: 'mono', label: '單色（隨背景自動）' },
  { key: 'gold', label: '全金色' },
  { key: 'gradient', label: '金色漸層' },
  { key: 'outline', label: '金色描邊' },
];

let siteCache = null;

/** 取得網站名稱與樣式（由後台設定，公開 API）。 */
async function getSite() {
  if (!siteCache) {
    try { siteCache = await API.get('/api/site'); }
    catch (_) { siteCache = {}; }
  }
  const name = (siteCache && siteCache.site_name) || DEFAULT_SITE_NAME;
  const style = (siteCache && siteCache.site_name_style) || DEFAULT_BRAND_STYLE;
  return { name, style };
}

/** 品牌字樣：只有「雙色」需要把名稱拆成前後兩段（後段為金色）。 */
function brandHtml(name, style = DEFAULT_BRAND_STYLE) {
  const s = String(name || DEFAULT_SITE_NAME);
  if (style !== 'duo') return escapeHtml(s);
  const cut = Math.max(1, Math.ceil(s.length / 2));
  const head = s.slice(0, cut);
  const tail = s.slice(cut);
  return tail ? `${escapeHtml(head)}<span>${escapeHtml(tail)}</span>` : escapeHtml(s);
}

/** 把名稱與樣式套到單一品牌元素。 */
function paintBrand(el, name, style) {
  el.className = el.className.replace(/\s*brand-style-[a-z]+/g, '').trim() + ' brand-style-' + style;
  el.innerHTML = brandHtml(name, style);
}

/** 把網站名稱套用到整頁（標題、品牌、頁尾等）。 */
async function applyBranding() {
  const { name, style } = await getSite();
  document.querySelectorAll('.brand').forEach((el) => paintBrand(el, name, style));
  document.querySelectorAll('[data-site-name]').forEach((el) => { el.textContent = name; });
  document.querySelectorAll('img[alt*="AURAFIT"]').forEach((img) => {
    img.alt = img.alt.split('AURAFIT').join(name);
  });
  if (document.title.includes(DEFAULT_SITE_NAME)) {
    document.title = document.title.split(DEFAULT_SITE_NAME).join(name);
  }
}

/* ===================== 前台頁首 ===================== */
function renderHeader(active = '') {
  const mount = document.getElementById('site-header');
  if (!mount) return;
  const user = Auth.getUser();
  const count = Cart.count();
  const brandName = (siteCache && siteCache.site_name) || DEFAULT_SITE_NAME;
  const brandStyle = (siteCache && siteCache.site_name_style) || DEFAULT_BRAND_STYLE;

  mount.innerHTML = `
    <div class="topbar">全館滿 NT$2,000 免運費 · 新會員首購現折 NT$200</div>
    <div class="nav container">
      <a class="brand brand-style-${brandStyle}" href="/index.html">${brandHtml(brandName, brandStyle)}</a>
      <nav class="nav-links">
        <a href="/index.html" class="${active === 'home' ? 'active' : ''}">所有商品</a>
        <a href="/index.html#featured">精選</a>
        <a href="/account.html" class="${active === 'account' ? 'active' : ''}">我的訂單</a>
      </nav>
      <div class="nav-right">
        <a class="icon-btn" href="/cart.html" title="購物車">
          🛍<span class="cart-count" ${count ? '' : 'hidden'}>${count}</span>
        </a>
        ${
          user
            ? `${Auth.isAdmin() ? '<a class="btn btn-admin btn-sm" href="/admin/" title="前往後台管理">🛠 後台管理</a>' : ''}
               <span class="user-chip">${escapeHtml(user.name)}</span>
               <button class="btn btn-ghost btn-sm" id="logout-btn">登出</button>`
            : `<a class="btn btn-dark btn-sm" href="/login.html">登入 / 註冊</a>`
        }
      </div>
    </div>
  `;

  const logout = document.getElementById('logout-btn');
  if (logout) {
    logout.addEventListener('click', async () => {
      try { await API.post('/api/auth/logout'); } catch (_) {}
      Auth.clear();
      toast('已登出');
      setTimeout(() => (window.location.href = '/index.html'), 400);
    });
  }

  applyBranding();
}

// 未使用 renderHeader 的頁面也要套用網站名稱
document.addEventListener('DOMContentLoaded', () => applyBranding());

window.addEventListener('cart:changed', () => {
  const el = document.querySelector('.cart-count');
  if (!el) return;
  const count = Cart.count();
  el.textContent = count;
  el.hidden = count === 0;
});

'use strict';

/* 後台權限檢查：非管理員一律導向登入頁 */
function requireAdmin() {
  const user = Auth.getUser();
  if (!Auth.isLoggedIn() || !user || user.role !== 'admin') {
    window.location.href = '/login.html?redirect=' + encodeURIComponent('/admin/');
    return null;
  }
  return user;
}

/* 側邊欄 */
function renderSidebar(active) {
  const mount = document.getElementById('admin-sidebar');
  if (!mount) return;
  const user = Auth.getUser();
  const links = [
    { key: 'dashboard', href: '/admin/', icon: '📊', label: '營運儀表板' },
    { key: 'products', href: '/admin/products.html', icon: '👕', label: '商品管理' },
    { key: 'categories', href: '/admin/categories.html', icon: '🏷', label: '分類管理' },
    { key: 'orders', href: '/admin/orders.html', icon: '📦', label: '訂單管理' },
    { key: 'payments', href: '/admin/payments.html', icon: '💳', label: '付款方式' },
    { key: 'settings', href: '/admin/settings.html', icon: '⚙️', label: '網站設定' },
  ];
  const brandName = (siteCache && siteCache.site_name) || DEFAULT_SITE_NAME;
  const brandStyle = (siteCache && siteCache.site_name_style) || DEFAULT_BRAND_STYLE;
  mount.innerHTML = `
    <a class="brand brand-style-${brandStyle}" href="/admin/">${brandHtml(brandName, brandStyle)}</a>
    <div class="subtitle">後台管理系統</div>
    ${links.map((l) => `<a href="${l.href}" class="${active === l.key ? 'active' : ''}"><span>${l.icon}</span>${l.label}</a>`).join('')}
    <div class="spacer"></div>
    <a href="/index.html"><span>🏬</span>回到前台</a>
    <a href="#" id="admin-logout"><span>🚪</span>登出</a>
    <div class="who">
      <strong>${escapeHtml(user ? user.name : '')}</strong>
      ${escapeHtml(user ? user.email : '')}
    </div>
  `;
  document.getElementById('admin-logout').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await API.post('/api/auth/logout'); } catch (_) {}
    Auth.clear();
    window.location.href = '/login.html';
  });

  // 在每個後台頁面頂端加入「前台 / 後台」切換列，方便自由進出
  const main = document.querySelector('.admin-main');
  if (main && !document.querySelector('.admin-mode-bar')) {
    const bar = document.createElement('div');
    bar.className = 'admin-mode-bar';
    bar.innerHTML = `
      <span class="mode-pill">後台管理模式</span>
      <span class="muted">你正以管理員身分操作，可隨時切換回前台。</span>
      <a class="btn btn-admin btn-sm" href="/index.html">↗ 回到前台商店</a>
    `;
    main.prepend(bar);
  }

  applyBranding();
}

/* 共用：提示錯誤 */
function showError(err) {
  toast(err && err.message ? err.message : '操作失敗', 'error');
}

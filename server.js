'use strict';

const express = require('express');
const path = require('node:path');
const { pool, all, get, run, initDatabase } = require('./db');
const { hashPassword, verifyPassword, generateToken } = require('./auth');

const app = express();
app.use(express.json());

/** 包裝非同步的路由處理函式，將錯誤交給 Express 的錯誤處理中介層。 */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- 工具函式 ----------

const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'completed', 'cancelled'];

const PAYMENT_SECTION_KEY = 'checkout_payment_enabled';

async function getSetting(key, fallback = '') {
  const row = await get('SELECT value FROM settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

/** 結帳頁是否顯示「付款方式」區塊。 */
async function isPaymentSectionEnabled() {
  return (await getSetting(PAYMENT_SECTION_KEY, '1')) === '1';
}

function toArray(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapProduct(row) {
  if (!row) return null;
  return {
    ...row,
    featured: !!row.featured,
    active: !!row.active,
    sizes: toArray(row.sizes),
    colors: toArray(row.colors),
  };
}

function mapOrder(row, items) {
  return { ...row, items: items || [] };
}

/** 解析 Authorization header 取得當前使用者。 */
async function getCurrentUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const row = await get(
    `SELECT u.id, u.name, u.email, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token]
  );
  return row ? { ...row, token } : null;
}

const authRequired = ah(async (req, res, next) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: '請先登入' });
  req.user = user;
  next();
});

const adminRequired = ah(async (req, res, next) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: '請先登入' });
  if (user.role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
  req.user = user;
  next();
});

// ---------- 認證 ----------

app.post('/api/auth/register', ah(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: '姓名、Email、密碼皆為必填' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: '密碼長度至少 6 個字元' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const exists = await get('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (exists) return res.status(409).json({ error: '此 Email 已被註冊' });

  const inserted = await get(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [String(name).trim(), normalizedEmail, hashPassword(password), 'customer']
  );

  const userId = inserted.id;
  const token = generateToken();
  await run('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  const user = await get('SELECT id, name, email, role FROM users WHERE id = $1', [userId]);
  res.status(201).json({ token, user });
}));

app.post('/api/auth/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '請輸入 Email 與密碼' });
  const normalizedEmail = String(email).trim().toLowerCase();
  const row = await get('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Email 或密碼錯誤' });
  }
  const token = generateToken();
  await run('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, row.id]);
  res.json({
    token,
    user: { id: row.id, name: row.name, email: row.email, role: row.role },
  });
}));

app.post('/api/auth/logout', authRequired, ah(async (req, res) => {
  await run('DELETE FROM sessions WHERE token = $1', [req.user.token]);
  res.json({ ok: true });
}));

app.get('/api/auth/me', authRequired, (req, res) => {
  const { id, name, email, role } = req.user;
  res.json({ user: { id, name, email, role } });
});

// ---------- 分類（公開） ----------

app.get('/api/categories', ah(async (req, res) => {
  const rows = await all(
    `SELECT c.*, (SELECT COUNT(*)::int FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count
     FROM categories c ORDER BY c.sort_order, c.id`
  );
  res.json(rows);
}));

// ---------- 網站設定（公開） ----------

const DEFAULT_SITE_NAME = 'AURAFIT';
const SITE_NAME_KEY = 'site_name';
const DEFAULT_BRAND_STYLE = 'duo';
const BRAND_STYLE_KEY = 'site_name_style';
const BRAND_STYLES = ['duo', 'mono', 'gold', 'gradient', 'outline'];

app.get('/api/site', ah(async (req, res) => {
  res.json({
    site_name: await getSetting(SITE_NAME_KEY, DEFAULT_SITE_NAME),
    site_name_style: await getSetting(BRAND_STYLE_KEY, DEFAULT_BRAND_STYLE),
  });
}));

// ---------- 付款方式（公開） ----------

// 結帳頁設定：是否顯示付款方式區塊 + 已開通的付款方式
app.get('/api/checkout-config', ah(async (req, res) => {
  const payment_enabled = await isPaymentSectionEnabled();
  const methods = payment_enabled
    ? await all('SELECT id, code, name, instructions FROM payment_methods WHERE enabled = 1 ORDER BY sort_order, id')
    : [];
  res.json({ payment_enabled, methods });
}));

app.get('/api/payment-methods', ah(async (req, res) => {
  const rows = await all('SELECT id, code, name, instructions FROM payment_methods WHERE enabled = 1 ORDER BY sort_order, id');
  res.json(rows);
}));

// ---------- 商品（公開） ----------

app.get('/api/products', ah(async (req, res) => {
  const { category, q, min, max, sort, featured } = req.query;
  const where = ['p.active = 1'];
  const params = [];

  if (category) {
    params.push(category);
    where.push(`c.slug = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`, `%${q}%`);
    where.push(`(p.name ILIKE $${params.length - 1} OR p.description ILIKE $${params.length})`);
  }
  if (min) {
    params.push(Number(min));
    where.push(`p.price >= $${params.length}`);
  }
  if (max) {
    params.push(Number(max));
    where.push(`p.price <= $${params.length}`);
  }
  if (featured === '1') {
    where.push('p.featured = 1');
  }

  let orderBy = 'p.created_at DESC, p.id DESC';
  if (sort === 'price_asc') orderBy = 'p.price ASC';
  else if (sort === 'price_desc') orderBy = 'p.price DESC';
  else if (sort === 'name') orderBy = 'p.name ASC';

  const rows = await all(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}`,
    params
  );

  res.json(rows.map(mapProduct));
}));

app.get('/api/products/:id', ah(async (req, res) => {
  const row = await get(
    `SELECT p.*, c.name AS category_name, c.slug AS category_slug
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = $1`,
    [Number(req.params.id)]
  );
  if (!row || !row.active) return res.status(404).json({ error: '找不到此商品' });
  res.json(mapProduct(row));
}));

// ---------- 訂單（會員） ----------

app.post('/api/orders', authRequired, ah(async (req, res) => {
  const { items, customer_name, phone, address, note, payment_method } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '購物車是空的' });
  }
  if (!customer_name || !phone || !address) {
    return res.status(400).json({ error: '收件人、電話、地址皆為必填' });
  }

  // 付款方式：若後台關閉了付款區塊，結帳不需選擇；否則必須是目前已開通的項目
  let method = { code: '', name: '', instructions: '' };
  if (await isPaymentSectionEnabled()) {
    const found = await get('SELECT * FROM payment_methods WHERE code = $1 AND enabled = 1', [String(payment_method || '')]);
    if (!found) {
      return res.status(400).json({ error: '請選擇有效的付款方式' });
    }
    method = found;
  }

  const lines = [];
  let total = 0;

  for (const item of items) {
    const product = await get('SELECT * FROM products WHERE id = $1 AND active = 1', [Number(item.product_id)]);
    if (!product) return res.status(400).json({ error: `商品 #${item.product_id} 不存在` });
    const qty = Math.max(1, Number(item.qty) || 1);
    if (qty > product.stock) {
      return res.status(400).json({ error: `「${product.name}」庫存不足（剩 ${product.stock} 件）` });
    }
    total += product.price * qty;
    lines.push({
      product_id: product.id,
      name: product.name,
      price: product.price,
      qty,
      size: item.size || '',
      color: item.color || '',
    });
  }

  const client = await pool.connect();
  let orderId;
  try {
    await client.query('BEGIN');
    const orderRes = await client.query(
      `INSERT INTO orders (user_id, total, status, customer_name, phone, address, note, payment_method, payment_name, payment_note)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        req.user.id, total,
        String(customer_name).trim(), String(phone).trim(), String(address).trim(),
        String(note || '').trim(),
        method.code, method.name, String(method.instructions || ''),
      ]
    );
    orderId = orderRes.rows[0].id;

    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, name, price, qty, size, color)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderId, line.product_id, line.name, line.price, line.qty, line.size, line.color]
      );
      await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [line.qty, line.product_id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ order_id: orderId, total, payment_name: method.name });
}));

app.get('/api/orders/mine', authRequired, ah(async (req, res) => {
  const orders = await all('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC', [req.user.id]);
  const withItems = await Promise.all(
    orders.map(async (o) => mapOrder(o, await all('SELECT * FROM order_items WHERE order_id = $1', [o.id])))
  );
  res.json(withItems);
}));

// ---------- 後台：儀表板 ----------

app.get('/api/admin/stats', adminRequired, ah(async (req, res) => {
  const productCount = (await get('SELECT COUNT(*)::int AS n FROM products')).n;
  const categoryCount = (await get('SELECT COUNT(*)::int AS n FROM categories')).n;
  const orderCount = (await get('SELECT COUNT(*)::int AS n FROM orders')).n;
  const revenue = (await get("SELECT COALESCE(SUM(total), 0)::float AS s FROM orders WHERE status != 'cancelled'")).s;
  const customerCount = (await get("SELECT COUNT(*)::int AS n FROM users WHERE role = 'customer'")).n;
  const lowStock = await all('SELECT id, name, stock FROM products WHERE stock <= 20 ORDER BY stock ASC LIMIT 5');
  const byStatus = await all('SELECT status, COUNT(*)::int AS n FROM orders GROUP BY status');
  const recentOrders = await all('SELECT id, customer_name, total, status, created_at FROM orders ORDER BY id DESC LIMIT 5');
  const topProducts = await all(
    `SELECT oi.name, SUM(oi.qty)::int AS sold, SUM(oi.qty * oi.price)::float AS revenue
     FROM order_items oi GROUP BY oi.name ORDER BY sold DESC LIMIT 5`
  );

  res.json({ productCount, categoryCount, orderCount, revenue, customerCount, lowStock, byStatus, recentOrders, topProducts });
}));

// ---------- 後台：分類管理 ----------

app.post('/api/admin/categories', adminRequired, ah(async (req, res) => {
  const { name, slug, description, sort_order } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: '分類名稱與代稱(slug)為必填' });
  const dup = await get('SELECT id FROM categories WHERE slug = $1', [slug]);
  if (dup) return res.status(409).json({ error: '此 slug 已存在' });
  const row = await get(
    'INSERT INTO categories (name, slug, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
    [String(name).trim(), String(slug).trim(), String(description || ''), Number(sort_order) || 0]
  );
  res.status(201).json(row);
}));

app.put('/api/admin/categories/:id', adminRequired, ah(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await get('SELECT * FROM categories WHERE id = $1', [id]);
  if (!existing) return res.status(404).json({ error: '找不到此分類' });
  const { name, slug, description, sort_order } = req.body || {};
  await run('UPDATE categories SET name = $1, slug = $2, description = $3, sort_order = $4 WHERE id = $5', [
    name ?? existing.name,
    slug ?? existing.slug,
    description ?? existing.description,
    sort_order ?? existing.sort_order,
    id,
  ]);
  res.json(await get('SELECT * FROM categories WHERE id = $1', [id]));
}));

app.delete('/api/admin/categories/:id', adminRequired, ah(async (req, res) => {
  const id = Number(req.params.id);
  const result = await run('DELETE FROM categories WHERE id = $1', [id]);
  if (result.rowCount === 0) return res.status(404).json({ error: '找不到此分類' });
  res.json({ ok: true });
}));

// ---------- 後台：網站設定 ----------

async function siteSettings() {
  return {
    checkout_payment_enabled: await isPaymentSectionEnabled(),
    site_name: await getSetting(SITE_NAME_KEY, DEFAULT_SITE_NAME),
    site_name_style: await getSetting(BRAND_STYLE_KEY, DEFAULT_BRAND_STYLE),
    brand_styles: BRAND_STYLES,
  };
}

app.get('/api/admin/settings', adminRequired, ah(async (req, res) => {
  res.json(await siteSettings());
}));

app.put('/api/admin/settings', adminRequired, ah(async (req, res) => {
  const { checkout_payment_enabled, site_name, site_name_style } = req.body || {};

  if (checkout_payment_enabled !== undefined) {
    await setSetting(PAYMENT_SECTION_KEY, checkout_payment_enabled ? '1' : '0');
  }

  if (site_name !== undefined) {
    const name = String(site_name).trim();
    if (!name) return res.status(400).json({ error: '網站名稱不可為空' });
    if (name.length > 30) return res.status(400).json({ error: '網站名稱請勿超過 30 個字' });
    await setSetting(SITE_NAME_KEY, name);
  }

  if (site_name_style !== undefined) {
    const style = String(site_name_style).trim();
    if (!BRAND_STYLES.includes(style)) {
      return res.status(400).json({ error: '不支援的品牌樣式' });
    }
    await setSetting(BRAND_STYLE_KEY, style);
  }

  res.json(await siteSettings());
}));

// ---------- 後台：管理員帳號（名稱 / Email / 密碼） ----------

app.get('/api/admin/account', adminRequired, ah(async (req, res) => {
  const row = await get('SELECT id, name, email FROM users WHERE id = $1', [req.user.id]);
  res.json(row);
}));

app.put('/api/admin/account', adminRequired, ah(async (req, res) => {
  const { current_password, name, email, new_password } = req.body || {};
  if (!current_password) {
    return res.status(400).json({ error: '請先輸入目前的密碼以確認身分' });
  }

  const row = await get('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!row || !verifyPassword(String(current_password), row.password_hash)) {
    return res.status(401).json({ error: '目前的密碼不正確' });
  }

  const updates = [];
  const values = [];

  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) return res.status(400).json({ error: '名稱不可為空' });
    values.push(n);
    updates.push(`name = $${values.length}`);
  }

  if (email !== undefined) {
    const e = String(email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      return res.status(400).json({ error: 'Email 格式不正確' });
    }
    const exists = await get('SELECT id FROM users WHERE email = $1 AND id <> $2', [e, req.user.id]);
    if (exists) return res.status(409).json({ error: '此 Email 已被其他帳號使用' });
    values.push(e);
    updates.push(`email = $${values.length}`);
  }

  if (new_password !== undefined && new_password !== '') {
    if (String(new_password).length < 6) {
      return res.status(400).json({ error: '新密碼長度至少 6 個字元' });
    }
    values.push(hashPassword(String(new_password)));
    updates.push(`password_hash = $${values.length}`);
  }

  if (!updates.length) return res.status(400).json({ error: '沒有要更新的內容' });

  values.push(req.user.id);
  await run(`UPDATE users SET ${updates.join(', ')} WHERE id = $${values.length}`, values);

  const user = await get('SELECT id, name, email, role FROM users WHERE id = $1', [req.user.id]);
  res.json({ ok: true, user });
}));

// ---------- 後台：付款方式管理 ----------

app.get('/api/admin/payment-methods', adminRequired, ah(async (req, res) => {
  const rows = await all('SELECT * FROM payment_methods ORDER BY sort_order, id');
  res.json(rows);
}));

app.post('/api/admin/payment-methods', adminRequired, ah(async (req, res) => {
  const { name, instructions, enabled, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: '付款方式名稱為必填' });
  const code = 'custom_' + Date.now().toString(36);
  const row = await get(
    'INSERT INTO payment_methods (code, name, instructions, enabled, builtin, sort_order) VALUES ($1, $2, $3, $4, 0, $5) RETURNING *',
    [code, String(name).trim(), String(instructions || ''), enabled === false ? 0 : 1, Number(sort_order) || 99]
  );
  res.status(201).json(row);
}));

app.put('/api/admin/payment-methods/:id', adminRequired, ah(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await get('SELECT * FROM payment_methods WHERE id = $1', [id]);
  if (!existing) return res.status(404).json({ error: '找不到此付款方式' });
  const { name, instructions, enabled, sort_order } = req.body || {};
  await run('UPDATE payment_methods SET name = $1, instructions = $2, enabled = $3, sort_order = $4 WHERE id = $5', [
    name != null ? String(name).trim() : existing.name,
    instructions != null ? String(instructions) : existing.instructions,
    enabled === undefined ? existing.enabled : (enabled ? 1 : 0),
    sort_order != null ? Number(sort_order) : existing.sort_order,
    id,
  ]);
  res.json(await get('SELECT * FROM payment_methods WHERE id = $1', [id]));
}));

app.delete('/api/admin/payment-methods/:id', adminRequired, ah(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await get('SELECT * FROM payment_methods WHERE id = $1', [id]);
  if (!existing) return res.status(404).json({ error: '找不到此付款方式' });
  if (existing.builtin) return res.status(400).json({ error: '內建付款方式不可刪除，請改用「停用」' });
  await run('DELETE FROM payment_methods WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// ---------- 後台：商品管理 ----------

app.get('/api/admin/products', adminRequired, ah(async (req, res) => {
  const rows = await all(
    `SELECT p.*, c.name AS category_name
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     ORDER BY p.id DESC`
  );
  res.json(rows.map(mapProduct));
}));

function normalizeProductBody(body) {
  return {
    name: String(body.name || '').trim(),
    description: String(body.description || '').trim(),
    price: Number(body.price) || 0,
    stock: Number(body.stock) || 0,
    category_id: body.category_id ? Number(body.category_id) : null,
    image: String(body.image || '').trim(),
    sizes: Array.isArray(body.sizes) ? body.sizes.join(',') : String(body.sizes || ''),
    colors: Array.isArray(body.colors) ? body.colors.join(',') : String(body.colors || ''),
    featured: body.featured ? 1 : 0,
    active: body.active === undefined || body.active ? 1 : 0,
  };
}

app.post('/api/admin/products', adminRequired, ah(async (req, res) => {
  const p = normalizeProductBody(req.body || {});
  if (!p.name) return res.status(400).json({ error: '商品名稱為必填' });
  const row = await get(
    `INSERT INTO products (name, description, price, stock, category_id, image, sizes, colors, featured, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [p.name, p.description, p.price, p.stock, p.category_id, p.image, p.sizes, p.colors, p.featured, p.active]
  );
  res.status(201).json(mapProduct(row));
}));

app.put('/api/admin/products/:id', adminRequired, ah(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await get('SELECT * FROM products WHERE id = $1', [id]);
  if (!existing) return res.status(404).json({ error: '找不到此商品' });
  const p = normalizeProductBody(req.body || {});
  await run(
    `UPDATE products SET name = $1, description = $2, price = $3, stock = $4, category_id = $5, image = $6, sizes = $7, colors = $8, featured = $9, active = $10
     WHERE id = $11`,
    [p.name || existing.name, p.description, p.price, p.stock, p.category_id, p.image, p.sizes, p.colors, p.featured, p.active, id]
  );
  res.json(mapProduct(await get('SELECT * FROM products WHERE id = $1', [id])));
}));

app.delete('/api/admin/products/:id', adminRequired, ah(async (req, res) => {
  const id = Number(req.params.id);
  const result = await run('DELETE FROM products WHERE id = $1', [id]);
  if (result.rowCount === 0) return res.status(404).json({ error: '找不到此商品' });
  res.json({ ok: true });
}));

// ---------- 後台：訂單管理 ----------

app.get('/api/admin/orders', adminRequired, ah(async (req, res) => {
  const { status } = req.query;
  const where = status ? 'WHERE o.status = $1' : '';
  const params = status ? [status] : [];
  const orders = await all(
    `SELECT o.*, u.email AS user_email
     FROM orders o LEFT JOIN users u ON u.id = o.user_id
     ${where} ORDER BY o.id DESC`,
    params
  );
  const withItems = await Promise.all(
    orders.map(async (o) => mapOrder(o, await all('SELECT * FROM order_items WHERE order_id = $1', [o.id])))
  );
  res.json(withItems);
}));

app.get('/api/admin/orders/:id', adminRequired, ah(async (req, res) => {
  const order = await get(
    `SELECT o.*, u.email AS user_email FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
    [Number(req.params.id)]
  );
  if (!order) return res.status(404).json({ error: '找不到此訂單' });
  const items = await all('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
  res.json(mapOrder(order, items));
}));

app.patch('/api/admin/orders/:id', adminRequired, ah(async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: '無效的訂單狀態' });
  const result = await run('UPDATE orders SET status = $1 WHERE id = $2', [status, id]);
  if (result.rowCount === 0) return res.status(404).json({ error: '找不到此訂單' });
  res.json(await get('SELECT * FROM orders WHERE id = $1', [id]));
}));

// ---------- 靜態檔案 ----------

app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// 404 for unknown API
app.use('/api', (req, res) => res.status(404).json({ error: 'API 不存在' }));

// 統一錯誤處理
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '伺服器發生錯誤' });
});

const PORT = process.env.PORT || 3000;

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`AURAFIT 服飾網站已啟動： http://localhost:${PORT}`);
      console.log(`後台管理： http://localhost:${PORT}/admin/`);
    });
  })
  .catch((err) => {
    console.error('資料庫初始化失敗：', err);
    process.exit(1);
  });

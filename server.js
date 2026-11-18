'use strict';

const express = require('express');
const path = require('node:path');
const { db, initDatabase } = require('./db');
const { hashPassword, verifyPassword, generateToken } = require('./auth');

initDatabase();

const app = express();
app.use(express.json());

// ---------- 工具函式 ----------

const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'completed', 'cancelled'];

const PAYMENT_SECTION_KEY = 'checkout_payment_enabled';

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

/** 結帳頁是否顯示「付款方式」區塊。 */
function isPaymentSectionEnabled() {
  return getSetting(PAYMENT_SECTION_KEY, '1') === '1';
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
function getCurrentUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);
  return row ? { ...row, token } : null;
}

function authRequired(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: '請先登入' });
  req.user = user;
  next();
}

function adminRequired(req, res, next) {
  const user = getCurrentUser(req);
  if (!user) return res.status(401).json({ error: '請先登入' });
  if (user.role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
  req.user = user;
  next();
}

// ---------- 認證 ----------

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: '姓名、Email、密碼皆為必填' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: '密碼長度至少 6 個字元' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (exists) return res.status(409).json({ error: '此 Email 已被註冊' });

  const result = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(String(name).trim(), normalizedEmail, hashPassword(password), 'customer');

  const userId = Number(result.lastInsertRowid);
  const token = generateToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId);
  res.status(201).json({ token, user });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '請輸入 Email 與密碼' });
  const normalizedEmail = String(email).trim().toLowerCase();
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Email 或密碼錯誤' });
  }
  const token = generateToken();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, row.id);
  res.json({
    token,
    user: { id: row.id, name: row.name, email: row.email, role: row.role },
  });
});

app.post('/api/auth/logout', authRequired, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.user.token);
  res.json({ ok: true });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const { id, name, email, role } = req.user;
  res.json({ user: { id, name, email, role } });
});

// ---------- 分類（公開） ----------

app.get('/api/categories', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS product_count
       FROM categories c ORDER BY c.sort_order, c.id`
    )
    .all();
  res.json(rows);
});

// ---------- 網站設定（公開） ----------

const DEFAULT_SITE_NAME = 'AURAFIT';
const SITE_NAME_KEY = 'site_name';
const DEFAULT_BRAND_STYLE = 'duo';
const BRAND_STYLE_KEY = 'site_name_style';
const BRAND_STYLES = ['duo', 'mono', 'gold', 'gradient', 'outline'];

app.get('/api/site', (req, res) => {
  res.json({
    site_name: getSetting(SITE_NAME_KEY, DEFAULT_SITE_NAME),
    site_name_style: getSetting(BRAND_STYLE_KEY, DEFAULT_BRAND_STYLE),
  });
});

// ---------- 付款方式（公開） ----------

// 結帳頁設定：是否顯示付款方式區塊 + 已開通的付款方式
app.get('/api/checkout-config', (req, res) => {
  const payment_enabled = isPaymentSectionEnabled();
  const methods = payment_enabled
    ? db
        .prepare('SELECT id, code, name, instructions FROM payment_methods WHERE enabled = 1 ORDER BY sort_order, id')
        .all()
    : [];
  res.json({ payment_enabled, methods });
});

app.get('/api/payment-methods', (req, res) => {
  const rows = db
    .prepare('SELECT id, code, name, instructions FROM payment_methods WHERE enabled = 1 ORDER BY sort_order, id')
    .all();
  res.json(rows);
});

// ---------- 商品（公開） ----------

app.get('/api/products', (req, res) => {
  const { category, q, min, max, sort, featured } = req.query;
  const where = ['p.active = 1'];
  const params = [];

  if (category) {
    where.push('c.slug = ?');
    params.push(category);
  }
  if (q) {
    where.push('(p.name LIKE ? OR p.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (min) {
    where.push('p.price >= ?');
    params.push(Number(min));
  }
  if (max) {
    where.push('p.price <= ?');
    params.push(Number(max));
  }
  if (featured === '1') {
    where.push('p.featured = 1');
  }

  let orderBy = 'p.created_at DESC, p.id DESC';
  if (sort === 'price_asc') orderBy = 'p.price ASC';
  else if (sort === 'price_desc') orderBy = 'p.price DESC';
  else if (sort === 'name') orderBy = 'p.name ASC';

  const rows = db
    .prepare(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}`
    )
    .all(...params);

  res.json(rows.map(mapProduct));
});

app.get('/api/products/:id', (req, res) => {
  const row = db
    .prepare(
      `SELECT p.*, c.name AS category_name, c.slug AS category_slug
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = ?`
    )
    .get(Number(req.params.id));
  if (!row || !row.active) return res.status(404).json({ error: '找不到此商品' });
  res.json(mapProduct(row));
});

// ---------- 訂單（會員） ----------

app.post('/api/orders', authRequired, (req, res) => {
  const { items, customer_name, phone, address, note, payment_method } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '購物車是空的' });
  }
  if (!customer_name || !phone || !address) {
    return res.status(400).json({ error: '收件人、電話、地址皆為必填' });
  }

  // 付款方式：若後台關閉了付款區塊，結帳不需選擇；否則必須是目前已開通的項目
  let method = { code: '', name: '', instructions: '' };
  if (isPaymentSectionEnabled()) {
    const found = db
      .prepare('SELECT * FROM payment_methods WHERE code = ? AND enabled = 1')
      .get(String(payment_method || ''));
    if (!found) {
      return res.status(400).json({ error: '請選擇有效的付款方式' });
    }
    method = found;
  }

  const getProduct = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  const lines = [];
  let total = 0;

  for (const item of items) {
    const product = getProduct.get(Number(item.product_id));
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

  let orderId;
  db.exec('BEGIN');
  try {
    const orderRes = db
      .prepare(
        `INSERT INTO orders (user_id, total, status, customer_name, phone, address, note, payment_method, payment_name, payment_note)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.user.id, total,
        String(customer_name).trim(), String(phone).trim(), String(address).trim(),
        String(note || '').trim(),
        method.code, method.name, String(method.instructions || '')
      );
    orderId = Number(orderRes.lastInsertRowid);

    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, name, price, qty, size, color)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const decStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
    for (const line of lines) {
      insertItem.run(orderId, line.product_id, line.name, line.price, line.qty, line.size, line.color);
      decStock.run(line.qty, line.product_id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.status(201).json({ order_id: orderId, total, payment_name: method.name });
});

app.get('/api/orders/mine', authRequired, (req, res) => {
  const orders = db
    .prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC')
    .all(req.user.id);
  const itemStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  res.json(orders.map((o) => mapOrder(o, itemStmt.all(o.id))));
});

// ---------- 後台：儀表板 ----------

app.get('/api/admin/stats', adminRequired, (req, res) => {
  const productCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  const categoryCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  const orderCount = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const revenue = db
    .prepare("SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE status != 'cancelled'")
    .get().s;
  const customerCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'").get().n;
  const lowStock = db
    .prepare('SELECT id, name, stock FROM products WHERE stock <= 20 ORDER BY stock ASC LIMIT 5')
    .all();
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
  const recentOrders = db
    .prepare('SELECT id, customer_name, total, status, created_at FROM orders ORDER BY id DESC LIMIT 5')
    .all();
  const topProducts = db
    .prepare(
      `SELECT oi.name, SUM(oi.qty) AS sold, SUM(oi.qty * oi.price) AS revenue
       FROM order_items oi GROUP BY oi.name ORDER BY sold DESC LIMIT 5`
    )
    .all();

  res.json({ productCount, categoryCount, orderCount, revenue, customerCount, lowStock, byStatus, recentOrders, topProducts });
});

// ---------- 後台：分類管理 ----------

app.post('/api/admin/categories', adminRequired, (req, res) => {
  const { name, slug, description, sort_order } = req.body || {};
  if (!name || !slug) return res.status(400).json({ error: '分類名稱與代稱(slug)為必填' });
  const dup = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
  if (dup) return res.status(409).json({ error: '此 slug 已存在' });
  const result = db
    .prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)')
    .run(String(name).trim(), String(slug).trim(), String(description || ''), Number(sort_order) || 0);
  res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(result.lastInsertRowid)));
});

app.put('/api/admin/categories/:id', adminRequired, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: '找不到此分類' });
  const { name, slug, description, sort_order } = req.body || {};
  db.prepare('UPDATE categories SET name = ?, slug = ?, description = ?, sort_order = ? WHERE id = ?').run(
    name ?? existing.name,
    slug ?? existing.slug,
    description ?? existing.description,
    sort_order ?? existing.sort_order,
    id
  );
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
});

app.delete('/api/admin/categories/:id', adminRequired, (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: '找不到此分類' });
  res.json({ ok: true });
});

// ---------- 後台：網站設定 ----------

function siteSettings() {
  return {
    checkout_payment_enabled: isPaymentSectionEnabled(),
    site_name: getSetting(SITE_NAME_KEY, DEFAULT_SITE_NAME),
    site_name_style: getSetting(BRAND_STYLE_KEY, DEFAULT_BRAND_STYLE),
    brand_styles: BRAND_STYLES,
  };
}

app.get('/api/admin/settings', adminRequired, (req, res) => {
  res.json(siteSettings());
});

app.put('/api/admin/settings', adminRequired, (req, res) => {
  const { checkout_payment_enabled, site_name, site_name_style } = req.body || {};

  if (checkout_payment_enabled !== undefined) {
    setSetting(PAYMENT_SECTION_KEY, checkout_payment_enabled ? '1' : '0');
  }

  if (site_name !== undefined) {
    const name = String(site_name).trim();
    if (!name) return res.status(400).json({ error: '網站名稱不可為空' });
    if (name.length > 30) return res.status(400).json({ error: '網站名稱請勿超過 30 個字' });
    setSetting(SITE_NAME_KEY, name);
  }

  if (site_name_style !== undefined) {
    const style = String(site_name_style).trim();
    if (!BRAND_STYLES.includes(style)) {
      return res.status(400).json({ error: '不支援的品牌樣式' });
    }
    setSetting(BRAND_STYLE_KEY, style);
  }

  res.json(siteSettings());
});

// ---------- 後台：管理員帳號（名稱 / Email / 密碼） ----------

app.get('/api/admin/account', adminRequired, (req, res) => {
  const row = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.user.id);
  res.json(row);
});

app.put('/api/admin/account', adminRequired, (req, res) => {
  const { current_password, name, email, new_password } = req.body || {};
  if (!current_password) {
    return res.status(400).json({ error: '請先輸入目前的密碼以確認身分' });
  }

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row || !verifyPassword(String(current_password), row.password_hash)) {
    return res.status(401).json({ error: '目前的密碼不正確' });
  }

  const updates = [];
  const values = [];

  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) return res.status(400).json({ error: '名稱不可為空' });
    updates.push('name = ?');
    values.push(n);
  }

  if (email !== undefined) {
    const e = String(email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      return res.status(400).json({ error: 'Email 格式不正確' });
    }
    const exists = db.prepare('SELECT id FROM users WHERE email = ? AND id <> ?').get(e, req.user.id);
    if (exists) return res.status(409).json({ error: '此 Email 已被其他帳號使用' });
    updates.push('email = ?');
    values.push(e);
  }

  if (new_password !== undefined && new_password !== '') {
    if (String(new_password).length < 6) {
      return res.status(400).json({ error: '新密碼長度至少 6 個字元' });
    }
    updates.push('password_hash = ?');
    values.push(hashPassword(String(new_password)));
  }

  if (!updates.length) return res.status(400).json({ error: '沒有要更新的內容' });

  values.push(req.user.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.user.id);
  res.json({ ok: true, user });
});

// ---------- 後台：付款方式管理 ----------

app.get('/api/admin/payment-methods', adminRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM payment_methods ORDER BY sort_order, id').all();
  res.json(rows);
});

app.post('/api/admin/payment-methods', adminRequired, (req, res) => {
  const { name, instructions, enabled, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: '付款方式名稱為必填' });
  const code = 'custom_' + Date.now().toString(36);
  const result = db
    .prepare('INSERT INTO payment_methods (code, name, instructions, enabled, builtin, sort_order) VALUES (?, ?, ?, ?, 0, ?)')
    .run(code, String(name).trim(), String(instructions || ''), enabled === false ? 0 : 1, Number(sort_order) || 99);
  res.status(201).json(db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(Number(result.lastInsertRowid)));
});

app.put('/api/admin/payment-methods/:id', adminRequired, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: '找不到此付款方式' });
  const { name, instructions, enabled, sort_order } = req.body || {};
  db.prepare('UPDATE payment_methods SET name = ?, instructions = ?, enabled = ?, sort_order = ? WHERE id = ?').run(
    name != null ? String(name).trim() : existing.name,
    instructions != null ? String(instructions) : existing.instructions,
    enabled === undefined ? existing.enabled : (enabled ? 1 : 0),
    sort_order != null ? Number(sort_order) : existing.sort_order,
    id
  );
  res.json(db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id));
});

app.delete('/api/admin/payment-methods/:id', adminRequired, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: '找不到此付款方式' });
  if (existing.builtin) return res.status(400).json({ error: '內建付款方式不可刪除，請改用「停用」' });
  db.prepare('DELETE FROM payment_methods WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- 後台：商品管理 ----------

app.get('/api/admin/products', adminRequired, (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*, c.name AS category_name
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       ORDER BY p.id DESC`
    )
    .all();
  res.json(rows.map(mapProduct));
});

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

app.post('/api/admin/products', adminRequired, (req, res) => {
  const p = normalizeProductBody(req.body || {});
  if (!p.name) return res.status(400).json({ error: '商品名稱為必填' });
  const result = db
    .prepare(
      `INSERT INTO products (name, description, price, stock, category_id, image, sizes, colors, featured, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(p.name, p.description, p.price, p.stock, p.category_id, p.image, p.sizes, p.colors, p.featured, p.active);
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(result.lastInsertRowid));
  res.status(201).json(mapProduct(row));
});

app.put('/api/admin/products/:id', adminRequired, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: '找不到此商品' });
  const p = normalizeProductBody(req.body || {});
  db.prepare(
    `UPDATE products SET name = ?, description = ?, price = ?, stock = ?, category_id = ?, image = ?, sizes = ?, colors = ?, featured = ?, active = ?
     WHERE id = ?`
  ).run(p.name || existing.name, p.description, p.price, p.stock, p.category_id, p.image, p.sizes, p.colors, p.featured, p.active, id);
  res.json(mapProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id)));
});

app.delete('/api/admin/products/:id', adminRequired, (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM products WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: '找不到此商品' });
  res.json({ ok: true });
});

// ---------- 後台：訂單管理 ----------

app.get('/api/admin/orders', adminRequired, (req, res) => {
  const { status } = req.query;
  const where = status ? 'WHERE o.status = ?' : '';
  const params = status ? [status] : [];
  const orders = db
    .prepare(
      `SELECT o.*, u.email AS user_email
       FROM orders o LEFT JOIN users u ON u.id = o.user_id
       ${where} ORDER BY o.id DESC`
    )
    .all(...params);
  const itemStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  res.json(orders.map((o) => mapOrder(o, itemStmt.all(o.id))));
});

app.get('/api/admin/orders/:id', adminRequired, (req, res) => {
  const order = db
    .prepare(
      `SELECT o.*, u.email AS user_email FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?`
    )
    .get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: '找不到此訂單' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  res.json(mapOrder(order, items));
});

app.patch('/api/admin/orders/:id', adminRequired, (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: '無效的訂單狀態' });
  const result = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
  if (result.changes === 0) return res.status(404).json({ error: '找不到此訂單' });
  res.json(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
});

// ---------- 靜態檔案 ----------

app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// 404 for unknown API
app.use('/api', (req, res) => res.status(404).json({ error: 'API 不存在' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AURAFIT 服飾網站已啟動： http://localhost:${PORT}`);
  console.log(`後台管理： http://localhost:${PORT}/admin/`);
});

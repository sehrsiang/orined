'use strict';

const { Pool } = require('pg');
const { hashPassword } = require('./auth');

// 資料庫連線：
// - 部署（Render + Neon）時，於環境變數 DATABASE_URL 設定 Neon 提供的連線字串
// - 本機開發若未設定，預設連到 localhost 的 Postgres
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aurafit';

// 連到雲端（Neon）通常需要 SSL；本機則否。
const needsSSL = /sslmode=require/.test(DATABASE_URL) || /neon\.tech/.test(DATABASE_URL);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needsSSL ? { rejectUnauthorized: false } : false,
});

/** 執行 SQL，回傳全部資料列。 */
async function all(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}

/** 執行 SQL，回傳第一列資料（沒有則回傳 null）。 */
async function get(text, params = []) {
  const rows = await all(text, params);
  return rows[0] || null;
}

/** 執行 SQL（寫入用），回傳原始結果（含 rowCount）。 */
async function run(text, params = []) {
  return pool.query(text, params);
}

/** 建立資料表結構（若不存在）。
 *  註：created_at 以文字儲存（格式與舊版 SQLite 相同），方便前端直接顯示。 */
async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT        NOT NULL,
      email         TEXT        NOT NULL UNIQUE,
      password_hash TEXT        NOT NULL,
      role          TEXT        NOT NULL DEFAULT 'customer',
      created_at    TEXT        NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS categories (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      sort_order  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      price       DOUBLE PRECISION NOT NULL DEFAULT 0,
      stock       INTEGER NOT NULL DEFAULT 0,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      image       TEXT DEFAULT '',
      sizes       TEXT DEFAULT '',
      colors      TEXT DEFAULT '',
      featured    INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS orders (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      total            DOUBLE PRECISION NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'pending',
      customer_name    TEXT NOT NULL,
      phone            TEXT NOT NULL,
      address          TEXT NOT NULL,
      note             TEXT DEFAULT '',
      payment_method   TEXT DEFAULT '',
      payment_name     TEXT DEFAULT '',
      payment_note     TEXT DEFAULT '',
      created_at       TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id         SERIAL PRIMARY KEY,
      order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      name       TEXT NOT NULL,
      price      DOUBLE PRECISION NOT NULL,
      qty        INTEGER NOT NULL,
      size       TEXT DEFAULT '',
      color      TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS payment_methods (
      id           SERIAL PRIMARY KEY,
      code         TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      instructions TEXT DEFAULT '',
      enabled      INTEGER NOT NULL DEFAULT 1,
      builtin      INTEGER NOT NULL DEFAULT 0,
      sort_order   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);
}

/** 舊資料庫的欄位升級（補上缺失的欄位）。 */
async function migrate() {
  await pool.query(`
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_name   TEXT DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_note   TEXT DEFAULT '';
  `);
}

/** 依 prompt 產生示範用商品圖片網址。 */
function img(prompt, size = 'portrait_4_3') {
  return `https://core-normal.trae.ai/api/ide/v1/text_to_image?prompt=${encodeURIComponent(
    prompt
  )}&image_size=${size}`;
}

const CATEGORIES = [
  { name: '上衣', slug: 'tops', description: 'T 恤、襯衫、針織衫等上身單品', sort_order: 1 },
  { name: '褲裝', slug: 'bottoms', description: '牛仔褲、西裝褲、寬褲等下著', sort_order: 2 },
  { name: '洋裝', slug: 'dresses', description: '日常與正式場合的連身洋裝', sort_order: 3 },
  { name: '外套', slug: 'outerwear', description: '風衣、夾克、開襟外套', sort_order: 4 },
  { name: '配件', slug: 'accessories', description: '包款、腰帶、圍巾、帽子', sort_order: 5 },
];

const PRODUCTS = [
  // 上衣
  { c: 'tops', name: '純棉圓領短袖 T 恤', price: 890, stock: 120, sizes: 'S,M,L,XL', colors: '白色,黑色,淺灰', featured: 1,
    description: '100% 精梳棉，親膚透氣，版型微寬鬆，日常百搭的必備單品。',
    prompt: 'professional apparel product photo of a plain cotton crew neck short sleeve t-shirt in off-white, minimalist light grey studio background, soft diffused lighting, catalog fashion photography, high detail fabric texture' },
  { c: 'tops', name: '條紋長袖針織衫', price: 1680, stock: 65, sizes: 'S,M,L', colors: '海軍藍,米白', featured: 0,
    description: '經典條紋設計，柔軟針織材質，秋冬內搭或單穿皆合適。',
    prompt: 'professional apparel product photo of a striped long sleeve knit sweater, navy and cream stripes, minimalist studio background, soft lighting, fashion catalog photography' },
  { c: 'tops', name: '絲質翻領襯衫', price: 2280, stock: 40, sizes: 'S,M,L,XL', colors: '象牙白,霧粉', featured: 1,
    description: '垂墜感絲質面料，俐落翻領，適合正式與半正式場合。',
    prompt: 'professional apparel product photo of an elegant silk button-up shirt with collar in ivory, minimalist studio background, soft lighting, luxury fashion catalog photography' },
  // 褲裝
  { c: 'bottoms', name: '高腰直筒牛仔褲', price: 1580, stock: 80, sizes: '25,26,27,28,29', colors: '淺藍,深藍', featured: 1,
    description: '高腰顯瘦剪裁，直筒版型修飾腿部線條，四季皆宜。',
    prompt: 'professional apparel product photo of high waisted straight leg denim jeans folded neatly, light blue wash, minimalist studio background, soft lighting, fashion catalog photography' },
  { c: 'bottoms', name: '亞麻寬褲', price: 1780, stock: 55, sizes: 'S,M,L', colors: '燕麥色,黑', featured: 0,
    description: '天然亞麻材質，透氣舒適，寬鬆版型帶出慵懶的度假感。',
    prompt: 'professional apparel product photo of wide leg linen trousers in oatmeal beige, minimalist studio background, soft natural lighting, fashion catalog photography' },
  { c: 'bottoms', name: '修身西裝長褲', price: 2180, stock: 48, sizes: 'S,M,L,XL', colors: '炭灰,黑', featured: 0,
    description: '微彈性西裝面料，修身直筒剪裁，商務通勤首選。',
    prompt: 'professional apparel product photo of tailored slim fit suit trousers in charcoal grey, minimalist studio background, soft lighting, business fashion catalog photography' },
  // 洋裝
  { c: 'dresses', name: '碎花連身洋裝', price: 2680, stock: 35, sizes: 'S,M,L', colors: '米底碎花,藍底碎花', featured: 1,
    description: '浪漫碎花印花，收腰設計，適合約會與春日出遊。',
    prompt: 'professional apparel product photo of a floral print midi dress on a mannequin, soft cream background with small flowers, minimalist studio, soft lighting, fashion catalog photography' },
  { c: 'dresses', name: '黑色小禮服', price: 3280, stock: 22, sizes: 'XS,S,M,L', colors: '黑', featured: 1,
    description: '經典小黑裙，簡約俐落的剪裁，出席晚宴與正式場合的萬用款。',
    prompt: 'professional apparel product photo of a classic little black dress, elegant minimal silhouette, minimalist studio background, dramatic soft lighting, luxury fashion catalog photography' },
  { c: 'dresses', name: '針織長版連身裙', price: 2480, stock: 30, sizes: 'S,M,L', colors: '奶茶色,墨綠', featured: 0,
    description: '柔軟針織材質，長版修身，秋冬溫暖又優雅。',
    prompt: 'professional apparel product photo of a long knit sweater dress in mocha brown, minimalist studio background, soft lighting, cozy fashion catalog photography' },
  // 外套
  { c: 'outerwear', name: '經典雙排扣風衣', price: 3980, stock: 25, sizes: 'S,M,L,XL', colors: '卡其,黑', featured: 1,
    description: '經典雙排扣設計，防潑水面料，春秋季節的百搭外套。',
    prompt: 'professional apparel product photo of a classic double breasted trench coat in beige khaki, minimalist studio background, soft lighting, fashion catalog photography' },
  { c: 'outerwear', name: '羊毛針織開襟外套', price: 2880, stock: 42, sizes: 'S,M,L', colors: '駝色,淺灰', featured: 0,
    description: '混羊毛材質保暖親膚，落肩版型慵懶有型。',
    prompt: 'professional apparel product photo of a wool knit cardigan in camel color, minimalist studio background, soft lighting, cozy fashion catalog photography' },
  { c: 'outerwear', name: '皮革飛行夾克', price: 4580, stock: 18, sizes: 'S,M,L', colors: '黑,咖啡', featured: 1,
    description: '質感皮革面料，飛行夾克版型，帥氣俐落。',
    prompt: 'professional apparel product photo of a leather bomber jacket in black, minimalist studio background, soft lighting, fashion catalog photography' },
  // 配件
  { c: 'accessories', name: '真皮細腰帶', price: 980, stock: 90, sizes: 'F', colors: '黑,棕', featured: 0,
    description: '頭層牛皮打造，簡約金屬扣，可搭配各式褲裝與洋裝。',
    prompt: 'professional product photo of a slim genuine leather belt with gold buckle coiled neatly, minimalist studio background, soft lighting, accessory catalog photography' },
  { c: 'accessories', name: '帆布托特包', price: 1280, stock: 70, sizes: 'F', colors: '米白,黑', featured: 1,
    description: '厚磅帆布耐用好裝，簡約外型適合日常通勤。',
    prompt: 'professional product photo of a minimalist canvas tote bag in natural beige, minimalist studio background, soft lighting, accessory catalog photography' },
  { c: 'accessories', name: '喀什米爾圍巾', price: 1880, stock: 60, sizes: 'F', colors: '駝,灰,酒紅', featured: 0,
    description: '柔軟喀什米爾混紡，親膚保暖，冬日必備單品。',
    prompt: 'professional product photo of a soft cashmere scarf in camel color neatly folded, minimalist studio background, soft lighting, accessory catalog photography' },
  { c: 'accessories', name: '羅紋針織毛帽', price: 680, stock: 110, sizes: 'F', colors: '黑,米白,墨綠', featured: 0,
    description: '羅紋針織保暖毛帽，彈性佳，戴起來修飾臉型。',
    prompt: 'professional product photo of a ribbed knit beanie hat in black, minimalist studio background, soft lighting, accessory catalog photography' },
];

/** 內建付款方式（管理員可在後台開啟／關閉或修改說明）。 */
const PAYMENT_METHODS = [
  {
    code: 'bank_transfer', name: '銀行轉帳 / ATM 匯款', builtin: 1, enabled: 1, sort_order: 1,
    instructions:
      '請於下單後 3 日內完成匯款，並於訂單備註回覆帳號後五碼，以利核對。\n銀行：台新銀行（812）\n帳號：1234-5678-9012-3456\n戶名：AURAFIT 服飾有限公司',
  },
  {
    code: 'ecpay', name: '綠界科技 ECPay（信用卡 / 超商）', builtin: 1, enabled: 1, sort_order: 2,
    instructions: '送出訂單後將導向綠界科技付款頁面，可選擇信用卡或超商代碼付款。',
  },
  {
    code: 'cod', name: '貨到付款', builtin: 1, enabled: 1, sort_order: 3,
    instructions: '商品送達時以現金支付，需加收物流代收手續費 NT$60。',
  },
  {
    code: 'custom_pay', name: '自訂付款（人工確認）', builtin: 0, enabled: 0, sort_order: 4,
    instructions: '已完成訂購，請依客服指示至指定地點或帳戶完成付款，付款後請回覆通知我們。',
  },
];

/** 寫入商店基本資料（分類、商品、帳號）。 */
async function seedStore() {
  const catIds = {};
  for (const c of CATEGORIES) {
    const row = await get(
      'INSERT INTO categories (name, slug, description, sort_order) VALUES ($1, $2, $3, $4) RETURNING id',
      [c.name, c.slug, c.description, c.sort_order]
    );
    catIds[c.slug] = row.id;
  }

  for (const p of PRODUCTS) {
    await run(
      `INSERT INTO products (name, description, price, stock, category_id, image, sizes, colors, featured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [p.name, p.description, p.price, p.stock, catIds[p.c], img(p.prompt), p.sizes, p.colors, p.featured]
    );
  }

  await run('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
    ['網站管理員', 'admin@aurafit.com', hashPassword('admin1234'), 'admin']);
  await run('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
    ['示範會員', 'user@aurafit.com', hashPassword('user1234'), 'customer']);

  console.log(
    `已寫入商店資料：${CATEGORIES.length} 個分類、${PRODUCTS.length} 件商品、2 個帳號。`
  );
}

/** 寫入內建付款方式（僅在資料表為空時執行）。 */
async function seedPaymentMethods() {
  for (const m of PAYMENT_METHODS) {
    await run(
      'INSERT INTO payment_methods (code, name, instructions, enabled, builtin, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
      [m.code, m.name, m.instructions, m.enabled, m.builtin, m.sort_order]
    );
  }
  console.log(`已寫入 ${PAYMENT_METHODS.length} 種付款方式。`);
}

/** 初始化資料庫：建立結構、必要時寫入初始資料。 */
async function initDatabase({ reset = false } = {}) {
  if (reset) {
    await pool.query(
      'DROP TABLE IF EXISTS order_items, orders, sessions, products, categories, users, payment_methods, settings CASCADE'
    );
  }
  await createSchema();
  await migrate();

  // 預設設定：結帳頁是否顯示「付款方式」區塊（1 = 顯示）
  await run("INSERT INTO settings (key, value) VALUES ('checkout_payment_enabled', '1') ON CONFLICT (key) DO NOTHING");
  // 預設設定：網站／品牌名稱（可於後台修改）
  await run("INSERT INTO settings (key, value) VALUES ('site_name', 'AURAFIT') ON CONFLICT (key) DO NOTHING");
  // 預設設定：品牌名稱樣式（可於後台切換）
  await run("INSERT INTO settings (key, value) VALUES ('site_name_style', 'duo') ON CONFLICT (key) DO NOTHING");

  const { n: count } = await get('SELECT COUNT(*)::int AS n FROM products');
  if (count === 0) {
    await seedStore();
  }

  const { n: pcount } = await get('SELECT COUNT(*)::int AS n FROM payment_methods');
  if (pcount === 0) {
    await seedPaymentMethods();
  }
}

if (require.main === module) {
  initDatabase({ reset: process.argv.includes('--reset') })
    .then(() => {
      console.log('資料庫初始化完成');
      return pool.end();
    })
    .catch((err) => {
      console.error('資料庫初始化失敗：', err);
      process.exit(1);
    });
}

module.exports = { pool, all, get, run, initDatabase };

const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// =========================
// Database
// =========================

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_otps (
      id SERIAL PRIMARY KEY,
      phone VARCHAR(20) NOT NULL,
      code VARCHAR(10) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      attempts INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token VARCHAR(100) UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      category VARCHAR(100),
      price VARCHAR(100),
      phone VARCHAR(30),
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deal_requests (
      id SERIAL PRIMARY KEY,
      ad_id INTEGER REFERENCES ads(id) ON DELETE CASCADE,
      buyer_phone VARCHAR(30),
      message TEXT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("Database initialized");
}

// =========================
// Helpers
// =========================

function normalizePhone(phone) {
  if (!phone) return null;

  let p = String(phone).trim().replace(/[^\d+]/g, "");

  if (p.startsWith("+98")) {
    p = "0" + p.substring(3);
  }

  if (p.startsWith("98") && p.length === 12) {
    p = "0" + p.substring(2);
  }

  if (/^9\d{9}$/.test(p)) {
    p = "0" + p;
  }

  if (!/^09\d{9}$/.test(p)) {
    return null;
  }

  return p;
}

function makeToken() {
  return require("crypto").randomBytes(40).toString("hex");
}

async function getUserFromRequest(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  const token = auth.substring(7).trim();

  if (!token) return null;

  const result = await pool.query(
    `
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = $1
      AND s.expires_at > NOW()
    `,
    [token]
  );

  return result.rows[0] || null;
}

// =========================
// Health
// =========================

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      ok: true,
      app: "معاملات پرشین"
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: "Database error"
    });
  }
});

// =========================
// Authentication
// =========================

app.post("/api/auth/request-code", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);

    if (!phone) {
      return res.status(400).json({
        ok: false,
        error: "شماره موبایل معتبر نیست"
      });
    }

    // Demo OTP
    const code = "123456";

    await pool.query(
      `
      DELETE FROM demo_otps
      WHERE phone = $1
      `,
      [phone]
    );

    await pool.query(
      `
      INSERT INTO demo_otps
      (phone, code, expires_at, attempts)
      VALUES ($1, $2, NOW() + INTERVAL '5 minutes', 0)
      `,
      [phone, code]
    );

    res.json({
      ok: true,
      message: "کد ورود ارسال شد",
      demo: true,
      code: "123456"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "خطا در ارسال کد"
    });
  }
});

app.post("/api/auth/verify", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || "").trim();

    if (!phone || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        ok: false,
        error: "اطلاعات ورود صحیح نیست"
      });
    }

    const otpResult = await pool.query(
      `
      SELECT *
      FROM demo_otps
      WHERE phone = $1
        AND expires_at > NOW()
      ORDER BY id DESC
      LIMIT 1
      `,
      [phone]
    );

    const otp = otpResult.rows[0];

    if (!otp) {
      return res.status(400).json({
        ok: false,
        error: "کد منقضی شده است"
      });
    }

    if (otp.attempts >= 5) {
      return res.status(429).json({
        ok: false,
        error: "تعداد تلاش‌ها بیش از حد مجاز است"
      });
    }

    if (otp.code !== code) {
      await pool.query(
        `
        UPDATE demo_otps
        SET attempts = attempts + 1
        WHERE id = $1
        `,
        [otp.id]
      );

      return res.status(400).json({
        ok: false,
        error: "کد وارد شده اشتباه است"
      });
    }

    let userResult = await pool.query(
      `
      SELECT *
      FROM users
      WHERE phone = $1
      `,
      [phone]
    );

    let user = userResult.rows[0];

    if (!user) {
      userResult = await pool.query(
        `
        INSERT INTO users (phone)
        VALUES ($1)
        RETURNING *
        `,
        [phone]
      );

      user = userResult.rows[0];
    }

    const token = makeToken();

    await pool.query(
      `
      INSERT INTO sessions
      (user_id, token, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '30 days')
      `,
      [user.id, token]
    );

    await pool.query(
      `
      DELETE FROM demo_otps
      WHERE phone = $1
      `,
      [phone]
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        phone: user.phone
      }
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "خطا در ورود"
    });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "وارد حساب نشده‌اید"
      });
    }

    res.json({
      ok: true,
      user: {
        id: user.id,
        phone: user.phone
      }
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "خطا"
    });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const auth = req.headers.authorization || "";

    if (auth.startsWith("Bearer ")) {
      const token = auth.substring(7).trim();

      await pool.query(
        `
        DELETE FROM sessions
        WHERE token = $1
        `,
        [token]
      );
    }

    res.json({
      ok: true
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "خطا در خروج"
    });
  }
});

// =========================
// Ads
// =========================

app.get("/api/ads", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const category = String(req.query.category || "").trim();

    let sql = `
      SELECT
        ads.*,
        users.phone AS owner_phone
      FROM ads
      LEFT JOIN users ON users.id = ads.user_id
      WHERE 1=1
    `;

    const params = [];

    if (q) {
      params.push(`%${q}%`);

      sql += `
        AND (
          ads.title ILIKE $${params.length}
          OR ads.description ILIKE $${params.length}
        )
      `;
    }

    if (category) {
      params.push(category);

      sql += `
        AND ads.category = $${params.length}
      `;
    }

    sql += `
      ORDER BY ads.created_at DESC
      LIMIT 100
    `;

    const result = await pool.query(sql, params);

    res.json({
      ok: true,
      ads: result.rows
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "خطا در دریافت آگهی‌ها"
    });
  }
});

app.post("/api/ads", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "ابتدا وارد حساب شوید"
      });
    }

    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    const category = String(req.body.category || "").trim();
    const price = String(req.body.price || "").trim();

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "عنوان آگهی الزامی است"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO ads
      (title, description, category, price, phone, user_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        title,
        description,
        category,
        price,
        user.phone,
        user.id
      ]
    );

    res.json({
      ok: true,
      ad: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "خطا در ثبت آگهی"
    });
  }
});

// =========================
// Deal requests
// =========================

app.post("/api/deals", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({
        ok: false,
        error: "ابتدا وارد حساب شوید"
      });
    }

    const adId = Number(req.body.adId);
    const message = String(req.body.message || "").trim();

    if (!Number.isInteger(adId) || adId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "آگهی نامعتبر است"
      });
    }

    const adResult = await pool.query(
      `
      SELECT *
      FROM ads
      WHERE id = $1
      `,
      [adId]
    );

    if (!adResult.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "آگهی پیدا نشد"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO deal_requests
      (ad_id, buyer_phone, message, user_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        adId,
        user.phone,
        message,
        user.id
      ]
    );

    res.json({
      ok: true,
      request: result.rows[0]
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "خطا در ثبت درخواست معامله"
    });
  }
});

// =========================
// Frontend
// =========================

app.get("/", async (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<title>معاملات پرشین</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: Tahoma, Arial, sans-serif;
  background: #0b0f14;
  color: #fff;
}

.container {
  width: 94%;
  max-width: 850px;
  margin: auto;
}

header {
  padding: 25px 0;
  text-align: center;
  border-bottom: 1px solid #252d36;
}

.logo {
  width: 80px;
  height: 80px;
  border-radius: 20px;
  margin: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #171d24;
  border: 2px solid #d4af37;
  color: #d4af37;
  font-size: 38px;
}

h1 {
  margin: 12px 0 5px;
  color: #d4af37;
}

.subtitle {
  color: #aab2bd;
}

.card {
  background: #131922;
  border: 1px solid #29323d;
  border-radius: 18px;
  padding: 20px;
  margin-top: 18px;
}

input,
textarea,
select {
  width: 100%;
  padding: 14px;
  margin: 7px 0;
  border-radius: 12px;
  border: 1px solid #394553;
  background: #0d1218;
  color: white;
  font-size: 16px;
}

textarea {
  min-height: 100px;
  resize: vertical;
}

button {
  width: 100%;
  padding: 14px;
  border: 0;
  border-radius: 12px;
  margin-top: 8px;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  background: #d4af37;
  color: #111;
}

button.secondary {
  background: #252d36;
  color: white;
}

button.danger {
  background: #8d3030;
  color: white;
}

.hidden {
  display: none;
}

.ad {
  border: 1px solid #303b47;
  border-radius: 15px;
  padding: 15px;
  margin-top: 12px;
  background: #10161e;
}

.ad h3 {
  color: #d4af37;
  margin-top: 0;
}

.price {
  color: #70d69a;
  font-weight: bold;
}

.small {
  color: #98a2ad;
  font-size: 13px;
}

.notice {
  background: #202a35;
  border-radius: 12px;
  padding: 12px;
  margin-top: 10px;
  color: #dce3ea;
}

#status {
  min-height: 24px;
  margin-top: 10px;
}
</style>
</head>

<body>

<div class="container">

<header>
  <div class="logo">↗</div>
  <h1>معاملات پرشین</h1>
  <div class="subtitle">بازار امن خرید، فروش و معامله</div>
</header>

<div id="loginBox" class="card">
  <h2>ورود به معاملات پرشین</h2>

  <input
    id="phone"
    type="tel"
    placeholder="شماره موبایل"
    inputmode="numeric"
  >

  <button onclick="requestCode()">
    دریافت کد ورود
  </button>

  <div id="codeBox" class="hidden">
    <input
      id="code"
      type="tel"
      maxlength="6"
      placeholder="کد ۶ رقمی"
      inputmode="numeric"
    >

    <button onclick="verifyCode()">
      ورود
    </button>

    <div class="notice">
      کد آزمایشی ورود:
      <strong>123456</strong>
    </div>
  </div>

  <div id="loginStatus" class="small"></div>
</div>

<div id="appBox" class="hidden">

  <div class="card">
    <h2>حساب کاربری</h2>
    <div id="account"></div>

    <button class="danger" onclick="logout()">
      خروج از حساب
    </button>
  </div>

  <div class="card">
    <h2>ثبت آگهی</h2>

    <input
      id="adTitle"
      placeholder="عنوان آگهی"
    >

    <select id="adCategory">
      <option value="">انتخاب دسته‌بندی</option>
      <option value="خودرو">خودرو</option>
      <option value="موبایل">موبایل</option>
      <option value="املاک">املاک</option>
      <option value="کالا">کالا</option>
      <option value="سایر">سایر</option>
    </select>

    <input
      id="adPrice"
      placeholder="قیمت"
    >

    <textarea
      id="adDescription"
      placeholder="توضیحات آگهی"
    ></textarea>

    <button onclick="createAd()">
      ثبت آگهی
    </button>

    <div id="adStatus" class="small"></div>
  </div>

</div>

<div class="card">

  <h2>آگهی‌ها</h2>

  <input
    id="search"
    placeholder="جستجو در آگهی‌ها..."
    oninput="loadAds()"
  >

  <select
    id="filterCategory"
    onchange="loadAds()"
  >
    <option value="">همه دسته‌ها</option>
    <option value="خودرو">خودرو</option>
    <option value="موبایل">موبایل</option>
    <option value="املاک">املاک</option>
    <option value="کالا">کالا</option>
    <option value="سایر">سایر</option>
  </select>

  <div id="ads"></div>

</div>

</div>

<script>

let token = localStorage.getItem("moamelat_token") || "";
let currentUser = null;

async function api(url, options = {}) {

  options.headers = options.headers || {};

  options.headers["Content-Type"] = "application/json";

  if (token) {
    options.headers["Authorization"] = "Bearer " + token;
  }

  const response = await fetch(url, options);

  let data = {};

  try {
    data = await response.json();
  } catch (_) {}

  if (!response.ok) {
    throw new Error(data.error || "خطا");
  }

  return data;
}

async function requestCode() {

  const phone = document.getElementById("phone").value.trim();
  const status = document.getElementById("loginStatus");

  status.textContent = "در حال ارسال کد...";

  try {

    const data = await api("/api/auth/request-code", {
      method: "POST",
      body: JSON.stringify({ phone })
    });

    document.getElementById("codeBox").classList.remove("hidden");

    status.textContent =
      "کد ارسال شد. برای نسخه آزمایشی از 123456 استفاده کن.";

  } catch (error) {

    status.textContent = error.message;
  }
}

async function verifyCode() {

  const phone = document.getElementById("phone").value.trim();
  const code = document.getElementById("code").value.trim();
  const status = document.getElementById("loginStatus");

  status.textContent = "در حال ورود...";

  try {

    const data = await api("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({
        phone,
        code
      })
    });

    token = data.token;

    localStorage.setItem(
      "moamelat_token",
      token
    );

    currentUser = data.user;

    showApp();

  } catch (error) {

    status.textContent = error.message;
  }
}

async function checkLogin() {

  if (!token) {
    return;
  }

  try {

    const data = await api("/api/auth/me");

    currentUser = data.user;

    showApp();

  } catch (_) {

    token = "";

    localStorage.removeItem(
      "moamelat_token"
    );
  }
}

function showApp() {

  document
    .getElementById("loginBox")
    .classList.add("hidden");

  document
    .getElementById("appBox")
    .classList.remove("hidden");

  document.getElementById("account").innerHTML =
    "شماره موبایل: <strong>" +
    currentUser.phone +
    "</strong>";

  loadAds();
}

async function logout() {

  try {

    await api("/api/auth/logout", {
      method: "POST"
    });

  } catch (_) {}

  token = "";

  currentUser = null;

  localStorage.removeItem(
    "moamelat_token"
  );

  location.reload();
}

async function createAd() {

  const title =
    document.getElementById("adTitle").value.trim();

  const category =
    document.getElementById("adCategory").value;

  const price =
    document.getElementById("adPrice").value.trim();

  const description =
    document.getElementById("adDescription").value.trim();

  const status =
    document.getElementById("adStatus");

  status.textContent = "در حال ثبت...";

  try {

    await api("/api/ads", {
      method: "POST",
      body: JSON.stringify({
        title,
        category,
        price,
        description
      })
    });

    document.getElementById("adTitle").value = "";
    document.getElementById("adPrice").value = "";
    document.getElementById("adDescription").value = "";

    status.textContent = "آگهی با موفقیت ثبت شد.";

    loadAds();

  } catch (error) {

    status.textContent = error.message;
  }
}

async function loadAds() {

  const q =
    document.getElementById("search").value.trim();

  const category =
    document.getElementById("filterCategory").value;

  try {

    const params = new URLSearchParams();

    if (q) params.set("q", q);

    if (category) {
      params.set("category", category);
    }

    const data =
      await api("/api/ads?" + params.toString());

    const container =
      document.getElementById("ads");

    if (!data.ads.length) {

      container.innerHTML =
        '<div class="notice">هنوز آگهی‌ای ثبت نشده است.</div>';

      return;
    }

    container.innerHTML =
      data.ads.map(ad => `

        <div class="ad">

          <h3>${escapeHtml(ad.title)}</h3>

          <div>
            ${escapeHtml(ad.description || "")}
          </div>

          ${
            ad.price
              ? `<p class="price">قیمت: ${escapeHtml(ad.price)}</p>`
              : ""
          }

          ${
            ad.category
              ? `<div class="small">
                  دسته‌بندی: ${escapeHtml(ad.category)}
                </div>`
              : ""
          }

          ${
            ad.owner_phone
              ? `<div class="small">
                  تماس: ${escapeHtml(ad.owner_phone)}
                </div>`
              : ""
          }

          ${
            currentUser
              ? `<button
                   class="secondary"
                   onclick="sendDeal(${ad.id})"
                 >
                   درخواست معامله
                 </button>`
              : ""
          }

        </div>

      `).join("");

  } catch (error) {

    document.getElementById("ads").innerHTML =
      '<div class="notice">خطا در دریافت آگهی‌ها</div>';
  }
}

async function sendDeal(adId) {

  const message =
    prompt("پیام خود برای فروشنده را وارد کنید:");

  if (message === null) {
    return;
  }

  try {

    await api("/api/deals", {
      method: "POST",
      body: JSON.stringify({
        adId,
        message
      })
    });

    alert("درخواست معامله با موفقیت ثبت شد.");

  } catch (error) {

    alert(error.message);
  }
}

function escapeHtml(value) {

  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

checkLogin();
loadAds();

</script>

</body>
</html>
  `);
});

// =========================
// Start
// =========================

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        "Moamelat Persian running on port " + PORT
      );
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });

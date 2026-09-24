const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      price TEXT,
      phone TEXT,
      description TEXT,
      owner TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deal_requests (
      id SERIAL PRIMARY KEY,
      ad_id INTEGER REFERENCES ads(id) ON DELETE CASCADE,
      buyer_name TEXT,
      buyer_phone TEXT,
      message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "معاملات پرشین" });
});

app.get("/api/ads", async (req, res) => {
  try {
    const { q = "", category = "" } = req.query;

    const result = await pool.query(
      `SELECT * FROM ads
       WHERE ($1 = '' OR title ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
       AND ($2 = '' OR category = $2)
       ORDER BY created_at DESC`,
      [q, category]
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "خطا در دریافت آگهی‌ها" });
  }
});

app.post("/api/ads", async (req, res) => {
  try {
    const {
      title,
      category,
      price,
      phone,
      description,
      owner
    } = req.body;

    if (!title) {
      return res.status(400).json({ error: "عنوان آگهی الزامی است" });
    }

    const result = await pool.query(
      `INSERT INTO ads
       (title, category, price, phone, description, owner)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        title,
        category || "",
        price || "",
        phone || "",
        description || "",
        owner || ""
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "خطا در ثبت آگهی" });
  }
});

app.post("/api/deals", async (req, res) => {
  try {
    const {
      ad_id,
      buyer_name,
      buyer_phone,
      message
    } = req.body;

    const result = await pool.query(
      `INSERT INTO deal_requests
       (ad_id, buyer_name, buyer_phone, message)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [
        ad_id,
        buyer_name || "",
        buyer_phone || "",
        message || ""
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "خطا در ثبت درخواست معامله" });
  }
});

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>معاملات پرشین</title>
<style>
body{font-family:Arial,sans-serif;background:#f5f6fa;margin:0;padding:20px}
.box{max-width:700px;margin:auto}
h1{text-align:center}
.card{background:white;padding:18px;margin:15px 0;border-radius:15px;box-shadow:0 2px 10px #ddd}
input,textarea,button{width:100%;box-sizing:border-box;padding:12px;margin:7px 0;border-radius:10px;border:1px solid #ddd}
button{background:#111;color:white;cursor:pointer}
.price{font-weight:bold;font-size:20px}
</style>
</head>
<body>
<div class="box">
<h1>🛍️ معاملات پرشین</h1>

<div class="card">
<h2>ثبت آگهی</h2>
<input id="title" placeholder="عنوان آگهی">
<input id="category" placeholder="دسته‌بندی">
<input id="price" placeholder="قیمت">
<input id="phone" placeholder="شماره تماس">
<input id="owner" placeholder="نام فروشنده">
<textarea id="description" placeholder="توضیحات"></textarea>
<button onclick="addAd()">ثبت آگهی</button>
</div>

<div class="card">
<h2>آگهی‌ها</h2>
<input id="search" placeholder="جستجو..." oninput="loadAds()">
<div id="ads">در حال دریافت آگهی‌ها...</div>
</div>
</div>

<script>
async function loadAds(){
  const q=document.getElementById("search").value;
  const r=await fetch("/api/ads?q="+encodeURIComponent(q));
  const ads=await r.json();

  document.getElementById("ads").innerHTML =
    ads.length
    ? ads.map(a=>\`
      <div class="card">
        <h3>\${escapeHtml(a.title)}</h3>
        <div>\${escapeHtml(a.category || "")}</div>
        <div class="price">\${escapeHtml(a.price || "قیمت توافقی")}</div>
        <p>\${escapeHtml(a.description || "")}</p>
        <b>تماس: \${escapeHtml(a.phone || "-")}</b>
      </div>
    \`).join("")
    : "هنوز آگهی‌ای ثبت نشده است.";
}

async function addAd(){
  const data={
    title:document.getElementById("title").value,
    category:document.getElementById("category").value,
    price:document.getElementById("price").value,
    phone:document.getElementById("phone").value,
    owner:document.getElementById("owner").value,
    description:document.getElementById("description").value
  };

  if(!data.title){
    alert("عنوان آگهی را وارد کن");
    return;
  }

  const r=await fetch("/api/ads",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(data)
  });

  if(r.ok){
    alert("آگهی با موفقیت ثبت شد");
    document.querySelectorAll("input,textarea").forEach(x=>x.value="");
    loadAds();
  }else{
    alert("ثبت آگهی انجام نشد");
  }
}

function escapeHtml(text){
  return String(text)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

init();

async function init(){
  try{
    await fetch("/api/health");
    loadAds();
  }catch(e){
    document.getElementById("ads").innerText="سرور در حال راه‌اندازی است.";
  }
}
</script>
</body>
</html>
  `);
});

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Moamelat Persian running on port " + PORT);
    });
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });

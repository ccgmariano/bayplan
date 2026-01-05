import express from "express";
import { pool } from "./db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

// helpers p/ ler SQL
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDb() {
  const sqlPath = path.join(__dirname, "sql", "create_voyages.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await pool.query(sql);
  console.log("DB initialized");
}

app.get("/health", (req, res) => res.status(200).send("OK"));

app.get("/db-health", async (req, res) => {
  try {
    const r = await pool.query("select 1 as ok");
    res.status(200).json({ ok: true, db: r.rows[0].ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ENDPOINTS DA 1ª TABELA
app.post("/voyages", async (req, res) => {
  const { vessel_name, voyage_code } = req.body;
  if (!vessel_name || !voyage_code) {
    return res.status(400).json({ error: "vessel_name and voyage_code are required" });
  }
  const r = await pool.query(
    "insert into voyages (vessel_name, voyage_code) values ($1,$2) returning *",
    [vessel_name, voyage_code]
  );
  res.status(201).json(r.rows[0]);
});

app.get("/voyages", async (req, res) => {
  const r = await pool.query(
    "select * from voyages order by created_at desc"
  );
  res.json(r.rows);
});

const PORT = Number(process.env.PORT) || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
  })
  .catch(err => {
    console.error("DB init failed:", err);
    process.exit(1);
  });

import express from "express";
import { pool } from "./db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// helpers p/ ler SQL
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDb() {
  // tabela voyages
  const voyagesPath = path.join(__dirname, "sql", "create_voyages.sql");
  const voyagesSql = fs.readFileSync(voyagesPath, "utf8");
  await pool.query(voyagesSql);

  // tabela worksets
  const worksetsPath = path.join(__dirname, "sql", "create_worksets.sql");
  const worksetsSql = fs.readFileSync(worksetsPath, "utf8");
  await pool.query(worksetsSql);

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

// ENDPOINTS DA TABELA VOYAGES
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

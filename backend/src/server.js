import express from "express";
import { pool } from "./db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";

const app = express();
app.use(express.json());

// --------------------
// CORS
// --------------------
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --------------------
// Helpers base
// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDb() {
  await pool.query(fs.readFileSync(path.join(__dirname, "sql", "create_voyages.sql"), "utf8"));
  await pool.query(fs.readFileSync(path.join(__dirname, "sql", "create_worksets.sql"), "utf8"));
  await pool.query(fs.readFileSync(path.join(__dirname, "sql", "create_operations.sql"), "utf8"));
  await pool.query(fs.readFileSync(path.join(__dirname, "sql", "create_paralisations.sql"), "utf8"));
  await pool.query(fs.readFileSync(path.join(__dirname, "sql", "create_edi_imports.sql"), "utf8"));
  await pool.query(fs.readFileSync(path.join(__dirname, "sql", "create_stowage_units.sql"), "utf8"));
  await pool.query(fs.readFileSync(path.join(__dirname, "sql", "create_containers.sql"), "utf8"));
  console.log("DB initialized");
}

// --------------------
// Health
// --------------------
app.get("/health", (_, res) => res.send("OK"));
app.get("/db-health", async (_, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --------------------
// BAY RULES (CORE)
// --------------------
function getBayGroup(bay) {
  const b = Number(bay);
  if (!Number.isInteger(b) || b <= 0) return [];

  // Ímpar → 20’ + 40’ adjacente
  if (b % 2 === 1) return [b, b + 1];

  // Par → 40’ (centro) + ímpares adjacentes
  return [b - 1, b, b + 1].filter(x => x > 0);
}

function normalizeDisplayBay(bay) {
  const b = Number(bay);
  if (!Number.isInteger(b) || b <= 0) return null;
  return b % 2 === 0 ? b - 1 : b;
}

// --------------------
// VOYAGES / WORKSETS
// --------------------
app.post("/voyages", async (req, res) => {
  const { vessel_name, voyage_code } = req.body;
  const r = await pool.query(
    "insert into voyages (vessel_name, voyage_code) values ($1,$2) returning *",
    [vessel_name, voyage_code]
  );
  res.json(r.rows[0]);
});

app.post("/worksets", async (req, res) => {
  const { voyage_id } = req.body;
  const r = await pool.query(
    "insert into worksets (voyage_id, type) values ($1,'OPERATION') returning *",
    [voyage_id]
  );
  res.json(r.rows[0]);
});

// --------------------
// IMPORTADOR EDI
// --------------------
const upload = multer({ storage: multer.memoryStorage() });

function parseBaplieMinimal(ediText) {
  const segs = ediText.replace(/\n/g, "").split("'").filter(Boolean);
  const units = [];
  let cur = null;

  for (const s of segs) {
    if (s.startsWith("EQD+CN+")) {
      if (cur) units.push(cur);
      const p = s.split("+");
      cur = { container_no: p[2], iso_type: p[3], bay: null, row: null, tier: null };
    }
    if (cur && s.startsWith("LOC+147+")) {
      const pos = (s.split("+")[2] || "").split(":")[0];
      if (pos.length >= 7) {
        cur.bay = parseInt(pos.slice(0, 3), 10);
        cur.row = parseInt(pos.slice(3, 5), 10);
        cur.tier = parseInt(pos.slice(5, 7), 10);
      }
    }
  }
  if (cur) units.push(cur);
  return units.filter(u => u.container_no);
}

app.post("/import/edi", upload.single("file"), async (req, res) => {
  const { vessel_name, voyage_code, operation_type } = req.body;
  const ediText = req.file.buffer.toString("utf8");

  const v = await pool.query(
    "insert into voyages (vessel_name, voyage_code) values ($1,$2) returning *",
    [vessel_name, voyage_code]
  );
  const voyage = v.rows[0];

  const w = await pool.query(
    "insert into worksets (voyage_id, type) values ($1,'OPERATION') returning *",
    [voyage.id]
  );
  const workset = w.rows[0];

  const units = parseBaplieMinimal(ediText);
  const bayArea = new Set();

  for (const u of units) {
    const area = u.tier >= 80 ? "DECK" : "HOLD";
    bayArea.add(`${u.bay}|${area}`);

    await pool.query(
      `insert into containers (workset_id, container_no, iso_type, bay, row, tier, area)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (workset_id, container_no) do update
       set bay=excluded.bay,row=excluded.row,tier=excluded.tier,area=excluded.area`,
      [workset.id, u.container_no, u.iso_type, u.bay, u.row, u.tier, area]
    );
  }

  for (const k of bayArea) {
    const [bay, area] = k.split("|");
    await pool.query(
      "insert into operations (workset_id, operation_type, bay, area) values ($1,$2,$3,$4)",
      [workset.id, operation_type, bay, area]
    );
  }

  res.json({ workset_id: workset.id, containers: units.length });
});

// --------------------
// OPS-BAYS
// --------------------
app.get("/ops-bays", async (req, res) => {
  const { workset_id, operation_type } = req.query;

  const r = await pool.query(
    `select bay, area from operations
     where workset_id=$1 and operation_type=$2`,
    [workset_id, operation_type]
  );

  const map = new Map();
  for (const it of r.rows) {
    const b = normalizeDisplayBay(it.bay);
    if (b !== null) map.set(`${b}|${it.area}`, { bay: b, area: it.area });
  }

  res.json({ items: [...map.values()] });
});

// --------------------
// BAYGRID
// --------------------
app.get("/baygrid", async (req, res) => {
  const { workset_id, bay, area } = req.query;
  const bay_group = getBayGroup(bay);

  const r = await pool.query(
    `select container_no, iso_type, bay, row, tier, status
     from containers
     where workset_id=$1 and bay=any($2::int[]) and area=$3`,
    [workset_id, bay_group, area]
  );

  let maxRow = 0, minTier = 999, maxTier = 0;
  r.rows.forEach(c => {
    if (c.row > maxRow) maxRow = c.row;
    if (c.tier < minTier) minTier = c.tier;
    if (c.tier > maxTier) maxTier = c.tier;
  });

  const rows_order = [...Array(maxRow).keys()].map(i => i + 1)
    .filter(r => r % 2 === 0).reverse()
    .concat([...Array(maxRow).keys()].map(i => i + 1).filter(r => r % 2 === 1));

  const tiers_order = [];
  for (let t = maxTier; t >= minTier; t -= 2) tiers_order.push(t);

  const grid = {};
  rows_order.forEach(r => grid[r] = {});
  r.rows.forEach(c => {
    grid[c.row][c.tier] = c;
  });

  res.json({ bay, bay_group, rows_order, tiers_order, grid });
});

// --------------------
// DONE
// --------------------
app.post("/containers/done", async (req, res) => {
  const { workset_id, container_no } = req.body;
  const r = await pool.query(
    `update containers set status='DONE', done_at=now()
     where workset_id=$1 and container_no=$2 returning *`,
    [workset_id, container_no]
  );
  res.json(r.rows[0]);
});

// --------------------
// ADMIN IMPORT UI
// --------------------
app.get("/admin/import", (_, res) => {
  res.send(`
<!doctype html>
<html><body>
<h2>Importar EDI</h2>
<form id="f">
<input name="vessel_name" value="APL NEW JERSEY"><br>
<input name="voyage_code" value="1GB1AN1MA"><br>
<select name="operation_type">
<option>DISCHARGE</option>
<option>LOAD</option>
</select><br>
<input type="file" name="file"><br>
<button>Importar</button>
</form>
<pre id="o"></pre>
<script>
f.onsubmit=async e=>{
e.preventDefault();
const fd=new FormData(f);
const r=await fetch('/import/edi',{method:'POST',body:fd});
o.textContent=await r.text();
}
</script>
</body></html>
  `);
});

// --------------------
const PORT = process.env.PORT || 3000;
initDb().then(() =>
  app.listen(PORT, () => console.log("Server on", PORT))
);

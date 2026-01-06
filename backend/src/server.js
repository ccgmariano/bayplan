// backend/src/server.js (ou onde estiver seu server.js)
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
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------------------
// BAY RULES (CORE)
// --------------------
// Regra atual (que estava no aprimoramento anterior):
// - Bay ímpar: inclui ela + a par adjacente (40' no meio)
// - Bay par: inclui [b-1, b, b+1] (debug/legado; vamos simplificar depois conforme sua regra final)
function getBayGroup(bay) {
  const b = Number(bay);
  if (!Number.isInteger(b) || b <= 0) return [];

  if (b % 2 === 1) return [b, b + 1];
  return [b - 1, b, b + 1].filter(x => x > 0);
}

// Normaliza para a bay “de exibição” (ímpar)
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
  if (!vessel_name || !voyage_code) {
    return res.status(400).json({ error: "vessel_name and voyage_code are required" });
  }

  const r = await pool.query(
    "insert into voyages (vessel_name, voyage_code) values ($1,$2) returning *",
    [vessel_name, voyage_code]
  );
  res.status(201).json(r.rows[0]);
});

app.post("/worksets", async (req, res) => {
  const { voyage_id } = req.body;
  if (!voyage_id) return res.status(400).json({ error: "voyage_id is required" });

  const r = await pool.query(
    "insert into worksets (voyage_id, type) values ($1,'OPERATION') returning *",
    [voyage_id]
  );
  res.status(201).json(r.rows[0]);
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
      cur = { container_no: p[2] || null, iso_type: p[3] || null, bay: null, row: null, tier: null };
      continue;
    }

    if (cur && s.startsWith("LOC+147+")) {
      const pos = (s.split("+")[2] || "").split(":")[0] || "";
      if (pos.length >= 7) {
        // bay com 3 dígitos no EDI (ex: 0440914)
        cur.bay = parseInt(pos.slice(0, 3), 10);
        cur.row = parseInt(pos.slice(3, 5), 10);
        cur.tier = parseInt(pos.slice(5, 7), 10);
      }
      continue;
    }
  }

  if (cur) units.push(cur);
  return units.filter(u => u.container_no);
}

app.post("/import/edi", upload.single("file"), async (req, res) => {
  try {
    const { vessel_name, voyage_code, operation_type } = req.body;

    if (!vessel_name || !voyage_code || !operation_type) {
      return res.status(400).json({ error: "vessel_name, voyage_code and operation_type are required" });
    }
    if (!["LOAD", "DISCHARGE"].includes(operation_type)) {
      return res.status(400).json({ error: "operation_type must be LOAD or DISCHARGE" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "file is required (multipart field name: file)" });
    }

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
    let containersSaved = 0;

    for (const u of units) {
      const area = (typeof u.tier === "number" && u.tier >= 80) ? "DECK" : "HOLD";
      if (typeof u.bay === "number") bayArea.add(`${u.bay}|${area}`);

      const rr = await pool.query(
        `insert into containers (workset_id, container_no, iso_type, bay, row, tier, area)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (workset_id, container_no) do update
           set iso_type = excluded.iso_type,
               bay      = excluded.bay,
               row      = excluded.row,
               tier     = excluded.tier,
               area     = excluded.area
         returning id`,
        [workset.id, u.container_no, u.iso_type, u.bay, u.row, u.tier, area]
      );
      if (rr.rowCount) containersSaved += 1;
    }

    for (const k of bayArea) {
      const [bayStr, area] = k.split("|");
      const bay = parseInt(bayStr, 10);
      await pool.query(
        "insert into operations (workset_id, operation_type, bay, area) values ($1,$2,$3,$4)",
        [workset.id, operation_type, bay, area]
      );
    }

    res.status(201).json({
      ok: true,
      voyage_id: voyage.id,
      workset_id: workset.id,
      containers_parsed: units.length,
      containers_saved: containersSaved,
      bays_with_ops: bayArea.size
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------------------
// OPS-BAYS
// --------------------
app.get("/ops-bays", async (req, res) => {
  const { workset_id, operation_type } = req.query;

  if (!workset_id || !operation_type) {
    return res.status(400).json({ error: "workset_id and operation_type are required" });
  }
  if (!["LOAD", "DISCHARGE"].includes(operation_type)) {
    return res.status(400).json({ error: "operation_type must be LOAD or DISCHARGE" });
  }

  const r = await pool.query(
    `select bay, area
     from operations
     where workset_id=$1 and operation_type=$2`,
    [workset_id, operation_type]
  );

  // Normaliza: bay par vira ímpar (display)
  const map = new Map(); // key displayBay|area
  for (const it of r.rows) {
    const b = normalizeDisplayBay(it.bay);
    if (b === null) continue;
    const key = `${b}|${it.area}`;
    if (!map.has(key)) map.set(key, { bay: b, area: it.area });
  }

  const items = Array.from(map.values()).sort((a, b) => {
    if (a.bay !== b.bay) return a.bay - b.bay;
    return String(a.area).localeCompare(String(b.area));
  });

  res.json({ workset_id: Number(workset_id), operation_type, items });
});

// --------------------
// BAYGRID
// --------------------
app.get("/baygrid", async (req, res) => {
  const { workset_id, bay, area } = req.query;

  if (!workset_id || !bay || !area) {
    return res.status(400).json({ error: "workset_id, bay and area are required" });
  }
  if (!["DECK", "HOLD"].includes(area)) {
    return res.status(400).json({ error: "area must be DECK or HOLD" });
  }

  const bayNum = Number(bay);
  if (!Number.isInteger(bayNum) || bayNum <= 0) {
    return res.status(400).json({ error: "bay must be a positive integer" });
  }

  const bay_group = getBayGroup(bayNum);
  if (!bay_group.length) return res.status(400).json({ error: "invalid bay" });

  const r = await pool.query(
    `select container_no, iso_type, bay, row, tier, status, done_at
     from containers
     where workset_id=$1 and bay=any($2::int[]) and area=$3`,
    [workset_id, bay_group, area]
  );

  let maxRow = 0;
  let minTier = Infinity;
  let maxTier = -Infinity;

  for (const c of r.rows) {
    if (Number.isFinite(c.row) && c.row > maxRow) maxRow = c.row;
    if (Number.isFinite(c.tier) && c.tier < minTier) minTier = c.tier;
    if (Number.isFinite(c.tier) && c.tier > maxTier) maxTier = c.tier;
  }

  // ordem de rows: pares desc, depois ímpares asc (modelo básico)
  const evens = [];
  for (let rr = maxRow; rr >= 2; rr--) if (rr % 2 === 0) evens.push(rr);
  const odds = [];
  for (let rr = 1; rr <= maxRow; rr++) if (rr % 2 === 1) odds.push(rr);
  const rows_order = [...evens, ...odds];

  // tiers: desc de 2 em 2 (modelo básico)
  const tiers_order = [];
  if (Number.isFinite(minTier) && Number.isFinite(maxTier)) {
    const start = (maxTier % 2 === 0) ? maxTier : (maxTier - 1);
    const end = (minTier % 2 === 0) ? minTier : (minTier + 1);
    for (let t = start; t >= end; t -= 2) tiers_order.push(t);
  }

  const grid = {};
  for (const rr of rows_order) grid[String(rr)] = {};
  for (const c of r.rows) {
    const rr = String(c.row);
    const tt = String(c.tier);
    if (!grid[rr]) grid[rr] = {};
    grid[rr][tt] = {
      container_no: c.container_no,
      iso_type: c.iso_type,
      status: c.status,
      done_at: c.done_at,
      bay: c.bay,
      row: c.row,
      tier: c.tier
    };
  }

  res.json({
    workset_id: Number(workset_id),
    bay: bayNum,
    bay_group,
    area,
    stats: {
      containers: r.rows.length,
      max_row: maxRow,
      min_tier: minTier === Infinity ? null : minTier,
      max_tier: maxTier === -Infinity ? null : maxTier
    },
    rows_order,
    tiers_order,
    grid
  });
});

// --------------------
// DONE / UNDONE
// --------------------
app.post("/containers/done", async (req, res) => {
  const { workset_id, container_no } = req.body;
  if (!workset_id || !container_no) {
    return res.status(400).json({ error: "workset_id and container_no are required" });
  }

  const r = await pool.query(
    `update containers
     set status='DONE', done_at=now()
     where workset_id=$1 and container_no=$2
     returning workset_id, container_no, status, done_at, bay, row, tier, area`,
    [workset_id, container_no]
  );

  if (r.rowCount === 0) return res.status(404).json({ error: "container not found for this workset_id" });
  res.json({ ok: true, container: r.rows[0] });
});

app.post("/containers/undone", async (req, res) => {
  const { workset_id, container_no } = req.body;
  if (!workset_id || !container_no) {
    return res.status(400).json({ error: "workset_id and container_no are required" });
  }

  const r = await pool.query(
    `update containers
     set status='PENDING', done_at=null
     where workset_id=$1 and container_no=$2
     returning workset_id, container_no, status, done_at, bay, row, tier, area`,
    [workset_id, container_no]
  );

  if (r.rowCount === 0) return res.status(404).json({ error: "container not found for this workset_id" });
  res.json({ ok: true, container: r.rows[0] });
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
  f.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(f);
    const r = await fetch('/import/edi', { method:'POST', body: fd });
    o.textContent = await r.text();
  };
</script>
</body></html>
  `);
});

// --------------------
const PORT = Number(process.env.PORT) || 3000;
initDb().then(() => app.listen(PORT, () => console.log("Server on", PORT)));

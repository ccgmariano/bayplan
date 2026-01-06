import express from "express";
import { pool } from "./db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";

const app = express();
app.use(express.json());

/* =======================
   CORS
======================= */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* =======================
   Helpers base
======================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function initDb() {
  const files = [
    "create_voyages.sql",
    "create_worksets.sql",
    "create_operations.sql",
    "create_paralisations.sql",
    "create_edi_imports.sql",
    "create_stowage_units.sql",
    "create_containers.sql"
  ];
  for (const f of files) {
    await pool.query(fs.readFileSync(path.join(__dirname, "sql", f), "utf8"));
  }
  console.log("DB initialized");
}

/* =======================
   Health
======================= */
app.get("/health", (_, res) => res.send("OK"));

/* =======================
   BAY RULES (CORE)
======================= */
function getBayGroup(bay) {
  const b = Number(bay);
  if (!Number.isInteger(b) || b <= 0) return [];
  if (b % 2 === 1) return [b, b + 1];          // bay operacional
  return [b - 1, b, b + 1].filter(x => x > 0); // 40'
}

function normalizeDisplayBay(bay) {
  const b = Number(bay);
  if (!Number.isInteger(b) || b <= 0) return null;
  return b % 2 === 0 ? b - 1 : b;
}

/* =======================
   IMPORTADOR EDI
======================= */
const upload = multer({ storage: multer.memoryStorage() });

function parseBaplieBRIBB(ediText, operationType) {
  const segs = ediText.replace(/\n/g, "").split("'").filter(Boolean);
  const units = [];
  let cur = null;
  let isBRIBB = false;

  for (const s of segs) {
    if (s.startsWith("EQD+CN+")) {
      if (cur && isBRIBB) units.push(cur);
      const p = s.split("+");
      cur = {
        container_no: p[2] || null,
        iso_type: p[3] || null,
        bay: null,
        row: null,
        tier: null,
        weight: null,
        od: null
      };
      isBRIBB = false;
      continue;
    }

    if (!cur) continue;

    // posição
    if (s.startsWith("LOC+147+")) {
      const pos = (s.split("+")[2] || "").split(":")[0];
      if (pos.length >= 7) {
        cur.bay = parseInt(pos.slice(0, 3), 10);
        cur.row = parseInt(pos.slice(3, 5), 10);
        cur.tier = parseInt(pos.slice(5, 7), 10);
      }
    }

    // porto (regra BRIBB)
    if (
      (operationType === "DISCHARGE" && s.startsWith("LOC+11+BRIBB")) ||
      (operationType === "LOAD" && s.startsWith("LOC+9+BRIBB"))
    ) {
      isBRIBB = true;
      cur.od = "BRIBB";
    }

    // peso bruto
    if (s.startsWith("MEA+AAE+G+KGM:")) {
      const v = s.split("KGM:")[1];
      if (v) cur.weight = Number(v);
    }
  }

  if (cur && isBRIBB) units.push(cur);
  return units.filter(u => u.container_no && u.bay && u.row && u.tier);
}

/* =======================
   IMPORT EDI
======================= */
app.post("/import/edi", upload.single("file"), async (req, res) => {
  const { vessel_name, voyage_code, operation_type } = req.body;
  if (!req.file) return res.status(400).json({ error: "file required" });

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

  const units = parseBaplieBRIBB(ediText, operation_type);
  const bayArea = new Set();

  for (const u of units) {
    const area = u.tier >= 80 ? "DECK" : "HOLD";
    bayArea.add(`${u.bay}|${area}`);

    await pool.query(
      `insert into containers
       (workset_id, container_no, iso_type, bay, row, tier, area, weight, od)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (workset_id, container_no) do update
       set bay=excluded.bay,
           row=excluded.row,
           tier=excluded.tier,
           area=excluded.area,
           weight=excluded.weight,
           od=excluded.od`,
      [
        workset.id,
        u.container_no,
        u.iso_type,
        u.bay,
        u.row,
        u.tier,
        area,
        u.weight,
        u.od
      ]
    );
  }

  for (const k of bayArea) {
    const [bay, area] = k.split("|");
    await pool.query(
      "insert into operations (workset_id, operation_type, bay, area) values ($1,$2,$3,$4)",
      [workset.id, operation_type, bay, area]
    );
  }

  res.json({
    workset_id: workset.id,
    containers_imported: units.length,
    bays: [...bayArea]
  });
});

/* =======================
   OPS-BAYS
======================= */
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

/* =======================
   BAYGRID
======================= */
app.get("/baygrid", async (req, res) => {
  const { workset_id, bay, area } = req.query;
  const bay_group = getBayGroup(bay);

  const r = await pool.query(
    `select container_no, iso_type, bay, row, tier, status, weight, od
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

  res.json({
    workset_id,
    bay,
    bay_group,
    area,
    rows_order,
    tiers_order,
    grid,
    stats: { containers: r.rows.length }
  });
});

/* =======================
   DONE / UNDONE
======================= */
app.post("/containers/done", async (req, res) => {
  const { workset_id, container_no } = req.body;
  const r = await pool.query(
    `update containers
     set status='DONE', done_at=now()
     where workset_id=$1 and container_no=$2
     returning *`,
    [workset_id, container_no]
  );
  res.json(r.rows[0]);
});

app.post("/containers/undone", async (req, res) => {
  const { workset_id, container_no } = req.body;
  const r = await pool.query(
    `update containers
     set status='PENDING', done_at=null
     where workset_id=$1 and container_no=$2
     returning *`,
    [workset_id, container_no]
  );
  res.json(r.rows[0]);
});

/* =======================
   ADMIN – DELETE WORKSET
======================= */
app.post("/admin/delete-workset", async (req, res) => {
  const { workset_id, confirm } = req.body;
  if (String(confirm) !== String(workset_id)) {
    return res.status(400).json({ error: "confirmation mismatch" });
  }

  await pool.query("delete from containers where workset_id=$1", [workset_id]);
  await pool.query("delete from operations where workset_id=$1", [workset_id]);
  await pool.query("delete from paralisations where workset_id=$1", [workset_id]);
  await pool.query("delete from worksets where id=$1", [workset_id]);

  res.json({ ok: true });
});

/* =======================
   ADMIN IMPORT UI
======================= */
app.get("/admin/import", (_, res) => {
  res.send(`
<!doctype html>
<html><body>
<h2>Importar EDI</h2>
<form id="f">
<input name="vessel_name" placeholder="Vessel"><br>
<input name="voyage_code" placeholder="Voyage"><br>
<select name="operation_type">
<option>DISCHARGE</option>
<option>LOAD</option>
</select><br>
<input type="file" name="file"><br>
<button>Importar</button>
</form>

<h3>Excluir Workset</h3>
<input id="wid" placeholder="workset_id">
<input id="conf" placeholder="digite o workset_id">
<button onclick="del()">Excluir</button>

<pre id="o"></pre>
<script>
f.onsubmit=async e=>{
 e.preventDefault();
 const fd=new FormData(f);
 const r=await fetch('/import/edi',{method:'POST',body:fd});
 o.textContent=await r.text();
}
async function del(){
 const r=await fetch('/admin/delete-workset',{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({workset_id:wid.value,confirm:conf.value})
 });
 o.textContent=await r.text();
}
</script>
</body></html>
`);
});

/* =======================
   START
======================= */
const PORT = process.env.PORT || 3000;
initDb().then(() =>
  app.listen(PORT, () => console.log("Server on", PORT))
);

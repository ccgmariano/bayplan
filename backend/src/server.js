import express from "express";
import { pool } from "./db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// helpers
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

app.get("/health", (req, res) => res.status(200).send("OK"));
app.get("/db-health", async (req, res) => {
  try {
    const r = await pool.query("select 1 as ok");
    res.status(200).json({ ok: true, db: r.rows[0].ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// VOYAGES
app.post("/voyages", async (req, res) => {
  const { vessel_name, voyage_code } = req.body;
  if (!vessel_name || !voyage_code) return res.status(400).json({ error: "vessel_name and voyage_code are required" });
  const r = await pool.query(
    "insert into voyages (vessel_name, voyage_code) values ($1,$2) returning *",
    [vessel_name, voyage_code]
  );
  res.status(201).json(r.rows[0]);
});
app.get("/voyages", async (_, res) => {
  const r = await pool.query("select * from voyages order by created_at desc");
  res.json(r.rows);
});

// WORKSETS
app.post("/worksets", async (req, res) => {
  const { voyage_id, type } = req.body;
  if (!voyage_id || !type) return res.status(400).json({ error: "voyage_id and type are required" });
  if (!["OPERATION", "PARALISATION"].includes(type)) return res.status(400).json({ error: "type must be OPERATION or PARALISATION" });
  const r = await pool.query(
    "insert into worksets (voyage_id, type) values ($1,$2) returning *",
    [voyage_id, type]
  );
  res.status(201).json(r.rows[0]);
});
app.get("/worksets", async (req, res) => {
  const { voyage_id } = req.query;
  if (!voyage_id) return res.status(400).json({ error: "voyage_id is required" });
  const r = await pool.query("select * from worksets where voyage_id = $1 order by created_at desc", [voyage_id]);
  res.json(r.rows);
});

// OPERATIONS
app.post("/operations", async (req, res) => {
  const { workset_id, operation_type, bay, area } = req.body;
  if (!workset_id || !operation_type || !bay || !area) {
    return res.status(400).json({ error: "workset_id, operation_type, bay and area are required" });
  }
  if (!["LOAD", "DISCHARGE"].includes(operation_type)) return res.status(400).json({ error: "operation_type must be LOAD or DISCHARGE" });
  if (!["DECK", "HOLD"].includes(area)) return res.status(400).json({ error: "area must be DECK or HOLD" });
  const r = await pool.query(
    "insert into operations (workset_id, operation_type, bay, area) values ($1,$2,$3,$4) returning *",
    [workset_id, operation_type, bay, area]
  );
  res.status(201).json(r.rows[0]);
});
app.get("/operations", async (req, res) => {
  const { workset_id } = req.query;
  if (!workset_id) return res.status(400).json({ error: "workset_id is required" });
  const r = await pool.query("select * from operations where workset_id = $1 order by created_at desc", [workset_id]);
  res.json(r.rows);
});

// PARALISATIONS
app.post("/paralisations", async (req, res) => {
  const { workset_id, started_at, ended_at, reason, notes } = req.body;
  if (!workset_id || !started_at || !reason) {
    return res.status(400).json({ error: "workset_id, started_at and reason are required" });
  }
  const r = await pool.query(
    `insert into paralisations (workset_id, started_at, ended_at, reason, notes)
     values ($1,$2,$3,$4,$5) returning *`,
    [workset_id, started_at, ended_at || null, reason, notes || null]
  );
  res.status(201).json(r.rows[0]);
});
app.get("/paralisations", async (req, res) => {
  const { workset_id } = req.query;
  if (!workset_id) return res.status(400).json({ error: "workset_id is required" });
  const r = await pool.query("select * from paralisations where workset_id = $1 order by started_at desc", [workset_id]);
  res.json(r.rows);
});

// --------- IMPORTADOR EDI ----------
const upload = multer({ storage: multer.memoryStorage() });

function detectMessageType(ediText) {
  const flat = ediText.replace(/\n/g, "");
  const segs = flat.split("'");
  return segs.find(s => s.startsWith("UNH+")) || null;
}

function parseBaplieMinimal(ediText) {
  const flat = ediText.replace(/\n/g, "");
  const segs = flat.split("'").filter(Boolean);

  const units = [];
  let current = null;

  for (const s of segs) {
    if (s.startsWith("EQD+CN+")) {
      if (current) units.push(current);

      const parts = s.split("+");
      const containerNo = parts[2] || null;
      const isoType = parts[3] || null;

      current = { container_no: containerNo, iso_type: isoType, bay: null, row: null, tier: null, raw_pos: null };
      continue;
    }

    if (current && s.startsWith("LOC+147+")) {
      const posPart = s.split("+")[2] || "";
      const pos = posPart.split(":")[0] || "";
      if (pos.length >= 7) {
        const bay = parseInt(pos.slice(0, 3), 10);
        const row = parseInt(pos.slice(3, 5), 10);
        const tier = parseInt(pos.slice(5, 7), 10);
        current.bay = Number.isFinite(bay) ? bay : null;
        current.row = Number.isFinite(row) ? row : null;
        current.tier = Number.isFinite(tier) ? tier : null;
        current.raw_pos = pos;
      }
      continue;
    }
  }
  if (current) units.push(current);
  return units.filter(u => u.container_no);
}

app.post("/import/edi", upload.single("file"), async (req, res) => {
  try {
    const { vessel_name, voyage_code, operation_type } = req.body;
    if (!vessel_name || !voyage_code || !operation_type) {
      return res.status(400).json({ error: "vessel_name, voyage_code and operation_type (LOAD|DISCHARGE) are required" });
    }
    if (!["LOAD", "DISCHARGE"].includes(operation_type)) {
      return res.status(400).json({ error: "operation_type must be LOAD or DISCHARGE" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "file is required (multipart field name: file)" });
    }

    const ediText = req.file.buffer.toString("utf8");
    detectMessageType(ediText); // mantém para futuro (auditoria), mas não precisamos retornar aqui

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

    const bayAreaSet = new Set();
    let containersInserted = 0;

    for (const u of units) {
      const tier = u.tier;
      const area = (typeof tier === "number" && tier >= 80) ? "DECK" : "HOLD";
      if (typeof u.bay === "number") bayAreaSet.add(`${u.bay}|${area}`);

      const c = await pool.query(
        `insert into containers (workset_id, container_no, iso_type, bay, row, tier, area)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (workset_id, container_no) do update
           set iso_type = excluded.iso_type,
               bay = excluded.bay,
               row = excluded.row,
               tier = excluded.tier,
               area = excluded.area
         returning id`,
        [workset.id, u.container_no, u.iso_type, u.bay, u.row, u.tier, area]
      );
      if (c.rowCount) containersInserted += 1;
    }

    for (const key of bayAreaSet) {
      const [bayStr, area] = key.split("|");
      const bay = parseInt(bayStr, 10);
      await pool.query(
        "insert into operations (workset_id, operation_type, bay, area) values ($1,$2,$3,$4)",
        [workset.id, operation_type, bay, area]
      );
    }

    return res.status(201).json({
      ok: true,
      voyage_id: voyage.id,
      workset_id: workset.id,
      containers_parsed: units.length,
      containers_saved: containersInserted,
      bays_with_ops: bayAreaSet.size
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// --------- Layout helpers ----------
function buildRowOrder(maxRow) {
  const evens = [];
  for (let r = maxRow; r >= 2; r--) if (r % 2 === 0) evens.push(r);

  const odds = [];
  for (let r = 1; r <= maxRow; r++) if (r % 2 === 1) odds.push(r);

  const has00 = (maxRow % 2 === 1);
  return has00 ? [...evens, 0, ...odds] : [...evens, ...odds];
}

function buildTierOrder(minTier, maxTier) {
  if (!Number.isFinite(minTier) || !Number.isFinite(maxTier)) return [];
  const start = (maxTier % 2 === 0) ? maxTier : maxTier - 1;
  const end = (minTier % 2 === 0) ? minTier : minTier + 1;

  const tiers = [];
  for (let t = start; t >= end; t -= 2) tiers.push(t);
  return tiers;
}

// --------- OPS-BAYS ----------
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
     where workset_id = $1 and operation_type = $2
     group by bay, area
     order by bay asc, area asc`,
    [workset_id, operation_type]
  );

  res.json({ workset_id: Number(workset_id), operation_type, items: r.rows });
});

// --------- BAYGRID ----------
app.get("/baygrid", async (req, res) => {
  const { workset_id, bay, area } = req.query;
  if (!workset_id || !bay || !area) return res.status(400).json({ error: "workset_id, bay and area are required" });
  if (!["DECK", "HOLD"].includes(area)) return res.status(400).json({ error: "area must be DECK or HOLD" });

  const r = await pool.query(
    `select container_no, iso_type, row, tier, status, done_at
     from containers
     where workset_id = $1 and bay = $2 and area = $3`,
    [workset_id, bay, area]
  );

  let maxRow = 0;
  let minTier = Infinity;
  let maxTier = -Infinity;

  for (const c of r.rows) {
    if (Number.isFinite(c.row) && c.row > maxRow) maxRow = c.row;
    if (Number.isFinite(c.tier) && c.tier < minTier) minTier = c.tier;
    if (Number.isFinite(c.tier) && c.tier > maxTier) maxTier = c.tier;
  }

  const rows_order = buildRowOrder(maxRow);
  const tiers_order = buildTierOrder(minTier === Infinity ? NaN : minTier, maxTier);

  const grid = {};
  for (const row of rows_order) grid[String(row)] = {};
  for (const c of r.rows) {
    const rr = String(c.row);
    const tt = String(c.tier);
    if (!grid[rr]) grid[rr] = {};
    grid[rr][tt] = {
      container_no: c.container_no,
      iso_type: c.iso_type,
      status: c.status,
      done_at: c.done_at
    };
  }

  res.json({
    workset_id: Number(workset_id),
    bay: Number(bay),
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

// --------- DONE (por enquanto só DONE) ----------
app.post("/containers/done", async (req, res) => {
  const { workset_id, container_no } = req.body;
  if (!workset_id || !container_no) {
    return res.status(400).json({ error: "workset_id and container_no are required" });
  }

  const r = await pool.query(
    `update containers
     set status = 'DONE', done_at = now()
     where workset_id = $1 and container_no = $2
     returning workset_id, container_no, status, done_at, bay, row, tier, area`,
    [workset_id, container_no]
  );

  if (r.rowCount === 0) {
    return res.status(404).json({ error: "container not found for this workset_id" });
  }

  res.json({ ok: true, container: r.rows[0] });
});

const PORT = Number(process.env.PORT) || 3000;

initDb()
  .then(() => app.listen(PORT, () => console.log(`Server listening on port ${PORT}`)))
  .catch(err => {
    console.error("DB init failed:", err);
    process.exit(1);
  });

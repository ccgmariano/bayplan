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
    const messageType = detectMessageType(ediText);

    // 1) voyage
    const v = await pool.query(
      "insert into voyages (vessel_name, voyage_code) values ($1,$2) returning *",
      [vessel_name, voyage_code]
    );
    const voyage = v.rows[0];

    // 2) workset OPERATION
    const w = await pool.query(
      "insert into worksets (voyage_id, type) values ($1,'OPERATION') returning *",
      [voyage.id]
    );
    const workset = w.rows[0];

    // 3) edi_import
    const imp = await pool.query(
      "insert into edi_imports (voyage_id, workset_id, filename, message_type) values ($1,$2,$3,$4) returning *",
      [voyage.id, workset.id, req.file.originalname || null, messageType]
    );
    const ediImport = imp.rows[0];

    // 4) parse units
    const units = parseBaplieMinimal(ediText);

    // 5) insert stowage_units + containers + operations
    const bayAreaSet = new Set();
    let containersInserted = 0;

    for (const u of units) {
      const tier = u.tier;
      const area = (typeof tier === "number" && tier >= 80) ? "DECK" : "HOLD";
      if (typeof u.bay === "number") bayAreaSet.add(`${u.bay}|${area}`);

      await pool.query(
        `insert into stowage_units
         (import_id, container_no, iso_type, bay, row, tier, area, raw_pos)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ediImport.id, u.container_no, u.iso_type, u.bay, u.row, u.tier, area, u.raw_pos]
      );

      // containers (dedupe por workset_id + container_no)
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
      import_id: ediImport.id,
      containers_parsed: units.length,
      containers_saved: containersInserted,
      bays_with_ops: bayAreaSet.size
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const PORT = Number(process.env.PORT) || 3000;

initDb()
  .then(() => app.listen(PORT, () => console.log(`Server listening on port ${PORT}`)))
  .catch(err => {
    console.error("DB init failed:", err);
    process.exit(1);
  });

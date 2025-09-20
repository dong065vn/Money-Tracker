import express from "express";
import cors from "cors";
import helmet from "helmet";
import fs from "fs/promises";
import path from "path";

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || "CHANGE_THIS_SECRET";
const DATA_PATH = path.join(process.cwd(), "data.json");

app.use(helmet());
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "1mb" }));

async function loadState() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      version: 0,
      updatedAt: new Date().toISOString(),
      state: { members: [], transactions: [] }
    };
  }
}

async function saveState(data) {
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
}

function auth(req, res, next) {
  const key = req.get("x-api-key");
  if (key !== API_KEY) return res.status(401).json({ error: "unauthorized" });
  next();
}

/* --- API --- */

// Get all state
app.get("/api/state", async (req, res) => {
  const data = await loadState();
  res.set("ETag", String(data.version));
  res.json(data);
});

// Replace whole state (optimistic concurrency)
app.put("/api/state", auth, async (req, res) => {
  const ifMatch = req.get("If-Match");
  const incoming = req.body?.state;
  if (!incoming || typeof incoming !== "object")
    return res.status(400).json({ error: "invalid state" });

  const current = await loadState();
  if (ifMatch != null && String(current.version) !== String(ifMatch)) {
    return res.status(409).json({ error: "version_conflict", current });
  }

  const next = {
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
    state: {
      members: incoming.members || [],
      transactions: incoming.transactions || []
    }
  };
  await saveState(next);
  res.set("ETag", String(next.version));
  res.json(next);
});

// Append helpers (optional)

// add transaction
app.post("/api/transactions", auth, async (req, res) => {
  const body = req.body;
  const db = await loadState();
  const tx = { ...body, id: body.id ?? Date.now() };
  db.state.transactions.unshift(tx);
  db.version += 1;
  db.updatedAt = new Date().toISOString();
  await saveState(db);
  res.set("ETag", String(db.version));
  res.json({ ok: true, version: db.version });
});

// delete transaction
app.delete("/api/transactions/:id", auth, async (req, res) => {
  const db = await loadState();
  db.state.transactions = db.state.transactions.filter(
    t => String(t.id) !== String(req.params.id)
  );
  db.version += 1;
  db.updatedAt = new Date().toISOString();
  await saveState(db);
  res.set("ETag", String(db.version));
  res.json({ ok: true, version: db.version });
});

// add member
app.post("/api/members", auth, async (req, res) => {
  const body = req.body;
  const db = await loadState();
  const m = { ...body, id: body.id ?? Date.now() };
  db.state.members.push(m);
  db.version += 1;
  db.updatedAt = new Date().toISOString();
  await saveState(db);
  res.set("ETag", String(db.version));
  res.json({ ok: true, version: db.version });
});

// delete member
app.delete("/api/members/:id", auth, async (req, res) => {
  const db = await loadState();
  const id = Number(req.params.id);
  db.state.members = db.state.members.filter(m => m.id !== id);
  // also clean references in transactions
  db.state.transactions = db.state.transactions.map(t => ({
    ...t,
    payerId: t.payerId === id ? (db.state.members[0]?.id ?? t.payerId) : t.payerId,
    paid: (t.paid || []).filter(p => p !== id),
    participants: (t.participants || []).filter(p => p !== id)
  }));
  db.version += 1;
  db.updatedAt = new Date().toISOString();
  await saveState(db);
  res.set("ETag", String(db.version));
  res.json({ ok: true, version: db.version });
});

app.listen(PORT, () => {
  console.log("Sync server on", PORT);
});

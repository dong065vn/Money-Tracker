import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import serveStatic from "serve-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// ===== API đồng bộ =====
let STATE = { members: [], transactions: [] };
let VERSION = 0;
let ETAG = `"v${VERSION}"`;
const API_KEY = process.env.API_KEY || "";

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.get("/api/state", (_, res) => {
  res.set("ETag", ETAG);
  res.json({ state: STATE, version: VERSION });
});

app.put("/api/state", (req, res) => {
  if (API_KEY && req.get("x-api-key") !== API_KEY) return res.status(403).json({ error: "forbidden" });
  const ifMatch = req.get("If-Match") || "";
  if (ifMatch && ifMatch !== ETAG) return res.status(409).json({ error: "conflict", current: { state: STATE, version: VERSION } });
  STATE = req.body.state || STATE;
  VERSION += 1;
  ETAG = `"v${VERSION}"`;
  res.set("ETag", ETAG);
  res.json({ ok: true, version: VERSION });
});

// ===== Serve static từ dist =====
const dist = path.join(__dirname, "dist");
app.use(serveStatic(dist, { index: false }));
app.get("*", (_, res) => res.sendFile(path.join(dist, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("app on", PORT));

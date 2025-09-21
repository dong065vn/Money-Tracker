import express from "express";
import cors from "cors";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = "./data.json";
const API_KEY = process.env.API_KEY || ""; // để trống = public
let STATE = { members: [], transactions: [] };
let VERSION = 0;
let ETAG = `"v${VERSION}"`;

// nạp state từ file nếu có
try {
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object") {
    STATE = parsed.state ?? STATE;
    VERSION = parsed.version ?? VERSION;
    ETAG = `"v${VERSION}"`;
  }
} catch {}

// ghi ra file
function persist() {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify({ state: STATE, version: VERSION }, null, 2),
    "utf8"
  );
}

app.get("/api/health", (_, res) => res.json({ ok: true }));

app.get("/api/state", (_, res) => {
  res.set("ETag", ETAG);
  res.json({ state: STATE, version: VERSION });
});

app.put("/api/state", (req, res) => {
  if (API_KEY && req.get("x-api-key") !== API_KEY) {
    return res.status(403).json({ error: "forbidden" });
  }
  const ifMatch = req.get("If-Match") || "";
  if (ifMatch && ifMatch !== ETAG) {
    return res
      .status(409)
      .json({ error: "conflict", current: { state: STATE, version: VERSION } });
  }

  STATE = req.body.state || STATE;
  VERSION += 1;
  ETAG = `"v${VERSION}"`;
  persist();

  res.set("ETag", ETAG);
  res.json({ ok: true, version: VERSION });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ sync-server running on", PORT));

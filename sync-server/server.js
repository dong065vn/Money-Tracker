// server.js (ESM)
import express from "express";
import cors from "cors";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();

// ====== CONFIG ======
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || process.env.SYNC_KEY || ""; // khoá gọi từ FE (x-api-key)
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

// ====== MIDDLEWARE ======
app.use(cors({ origin: ALLOW_ORIGIN, credentials: false }));
app.use(express.json({ limit: "1mb" }));

// ====== IN-MEMORY STATE (demo) ======
let STATE = {
  members: [],
  transactions: []
};
let VERSION = 0;
let ETAG = makeEtag(VERSION);

function makeEtag(v) {
  return `"v-${v}-${crypto.randomBytes(4).toString("hex")}"`;
}

function needApiKey(req) {
  // Nếu bạn muốn bắt buộc API key: đặt biến môi trường API_KEY khác rỗng
  if (!API_KEY) return false;
  const k = req.get("x-api-key") || "";
  return k !== API_KEY;
}

function getUserId(req) {
  return req.get("x-user-id") || "anon";
}

// ====== HEALTH ======
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, version: VERSION });
});

// ====== STATE ======
// GET state (kèm ETag)
app.get("/api/state", (req, res) => {
  res.set("ETag", ETAG);
  res.status(200).json({ state: STATE, version: VERSION, user: getUserId(req) });
});

// PUT state (If-Match + optional API key)
app.put("/api/state", (req, res) => {
  if (needApiKey(req)) {
    return res.status(401).json({ error: "invalid_api_key" });
  }

  const ifMatch = req.get("If-Match") || "";
  if (ETAG && ifMatch && ifMatch !== ETAG) {
    // xung đột
    res.status(409).json({ error: "etag_conflict", current: { state: STATE, version: VERSION } });
    return;
  }

  const body = req.body || {};
  const nextState = body.state;
  if (!nextState || typeof nextState !== "object") {
    return res.status(400).json({ error: "invalid_state" });
  }

  STATE = nextState;
  VERSION += 1;
  ETAG = makeEtag(VERSION);

  res.set("ETag", ETAG);
  res.status(200).json({ ok: true, version: VERSION });
});

// ====== OAUTH URL (backend trả URL cho FE mở popup) ======
app.get("/api/auth/url", (req, res) => {
  // Stub cho môi trường dev: trả 1 URL giả (FE chỉ cần có url để mở)
  const user = encodeURIComponent(getUserId(req));
  const url = `${req.protocol}://${req.get("host")}/mock-oauth?user=${user}`;
  res.status(200).json({ url });
});

// (Tuỳ chọn) mock trang oauth để test nhanh
app.get("/mock-oauth", (_req, res) => {
  res.status(200).send(`
    <html>
      <body style="font-family: system-ui; padding: 24px;">
        <h3>Mock OAuth</h3>
        <p>Đây là trang giả lập. Đóng tab và quay lại ứng dụng.</p>
      </body>
    </html>
  `);
});

// ====== DRIVE SAVE (STUB) ======
app.post("/api/drive/save", (req, res) => {
  // Ở bản stub này mình luôn trả 200 để FE không hiện cảnh báo.
  // body có thể gồm { state } hoặc gì đó—ta bỏ qua.
  const user = getUserId(req);
  res.status(200).json({
    ok: true,
    user,
    saved: false,
    reason: "not_configured", // thay bằng 'saved:true, fileId:...' nếu bạn gắn Google Drive thật
  });
});

// ====== 405 helpers ======
app.get("/api/drive/save", (_req, res) => {
  res.status(405).json({ error: "use_POST_here" });
});

// ====== START ======
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});

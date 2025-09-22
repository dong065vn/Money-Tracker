// server.js — ESM
// ===============================
// Sync API + Google Drive (per-user)
// ===============================
import "dotenv/config";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { fileURLToPath } from "url";
import { google } from "googleapis";

/* ============ PATHS ============ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ============ CONFIG ============ */
const PORT = process.env.PORT || 3000;

// Cho phép FE gọi CORS (nhiều origin)
const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://money-tracker-opal-sigma.vercel.app",
];
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || ""; // có thể truyền 1 hoặc nhiều, phân tách dấu phẩy
const EXTRA_ORIGINS = FRONTEND_ORIGIN
  ? FRONTEND_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
const ALLOWED_ORIGINS = Array.from(new Set([...DEFAULT_ORIGINS, ...EXTRA_ORIGINS]));

// (tùy chọn) API key nếu muốn khóa ghi server
const API_KEY = process.env.API_KEY || "";

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
// ví dụ: https://<your-domain>/api/oauth2callback
const OAUTH_REDIRECT_URL =
  process.env.GOOGLE_REDIRECT_URI || process.env.OAUTH_REDIRECT_URL || "";

// Lưu ở appDataFolder (kín) hoặc ở drive thường
const DRIVE_MODE = process.env.DRIVE_MODE || "appDataFolder"; // "appDataFolder" | "drive"
const REQUIRE_USER_LINK = String(process.env.REQUIRE_USER_LINK || "false") === "true";

// Tên file mặc định lưu trên Drive cho mỗi user
const DRIVE_FILENAME = "moneytracker_state.json";

// Fallback tương thích ngược: dữ liệu local
const LOCAL_DATA_FILE = path.join(__dirname, "data.json");

// Token lưu theo user (JSON file đơn giản)
const TOKENS_FILE = path.join(__dirname, "tokens.json");

/* ============ APP ============ */
const app = express();
app.use(express.json({ limit: "4mb" }));

// CORS linh hoạt theo origin
app.use(
  cors({
    origin(origin, cb) {
      // Cho phép tools không có Origin (curl/health checks)
      if (!origin) return cb(null, true);
      return cb(null, ALLOWED_ORIGINS.includes(origin));
    },
    credentials: false,
  })
);
// preflight
app.options("*", cors());

/* ============ LOCAL FALLBACK STORE (giữ tương thích ngược) ============ */
let LOCAL_STATE = { members: [], transactions: [] };
let LOCAL_VERSION = 0;
let LOCAL_ETAG = `"v${LOCAL_VERSION}"`;

try {
  const raw = fs.readFileSync(LOCAL_DATA_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object") {
    LOCAL_STATE = parsed.state ?? LOCAL_STATE;
    LOCAL_VERSION = parsed.version ?? LOCAL_VERSION;
    LOCAL_ETAG = `"v${LOCAL_VERSION}"`;
  }
} catch {
  // ignore
}

function persistLocal() {
  fs.writeFileSync(
    LOCAL_DATA_FILE,
    JSON.stringify({ state: LOCAL_STATE, version: LOCAL_VERSION }, null, 2),
    "utf8"
  );
}

const newEtag = () => `"${crypto.randomBytes(8).toString("hex")}"`;

/* ============ TOKEN STORE (per-user) ============ */
function readTokens() {
  try {
    const raw = fs.readFileSync(TOKENS_FILE, "utf8");
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}
function writeTokens(all) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(all, null, 2), "utf8");
}
function getUserToken(userId) {
  const all = readTokens();
  return userId ? all[userId] || null : null;
}
function saveUserToken(userId, tokens) {
  const all = readTokens();
  all[userId] = tokens;
  writeTokens(all);
}

/* ============ GOOGLE OAUTH + DRIVE HELPERS ============ */
function getOAuth2Client(userId) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !OAUTH_REDIRECT_URL) return null;
  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    OAUTH_REDIRECT_URL
  );
  const saved = userId ? getUserToken(userId) : null;
  if (saved) oauth2.setCredentials(saved);
  return oauth2;
}
function getDriveClient(oauth2) {
  return google.drive({ version: "v3", auth: oauth2 });
}
app.post("/api/auth/reset", (req, res) => {
  const uid = req.header("x-user-id");
  if (!uid) return res.status(400).json({ error: "Missing x-user-id" });
  tokenStore.delete(uid);
  return res.json({ ok: true });
});

// Tìm (hoặc tạo) file của user
async function ensureUserFile(drive) {
  const q =
    DRIVE_MODE === "appDataFolder"
      ? `name='${DRIVE_FILENAME}' and 'appDataFolder' in parents`
      : `name='${DRIVE_FILENAME}' and trashed=false`;

  const { data } = await drive.files.list({
    q,
    fields: "files(id, name, modifiedTime, md5Checksum)",
  });
  if (data.files && data.files.length) return data.files[0];

  const fileMeta =
    DRIVE_MODE === "appDataFolder"
      ? { name: DRIVE_FILENAME, parents: ["appDataFolder"] }
      : { name: DRIVE_FILENAME };

  const body = JSON.stringify({ state: { members: [], transactions: [] }, version: 0 });
  const created = await drive.files.create({
    requestBody: fileMeta,
    media: { mimeType: "application/json", body },
    fields: "id, name, modifiedTime, md5Checksum",
  });
  return created.data;
}

async function loadFromDrive(userId) {
  const oauth2 = getOAuth2Client(userId);
  if (!oauth2) throw new Error("oauth_not_configured");
  if (!oauth2.credentials || !oauth2.credentials.access_token) throw new Error("not_linked");

  const drive = getDriveClient(oauth2);
  const file = await ensureUserFile(drive);

  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "json" }
  );
  const body = res.data || { state: { members: [], transactions: [] }, version: 0 };
  const version = Number(body.version || 0);
  const etag = `"v${version}"`;
  return { fileId: file.id, state: body.state || { members: [], transactions: [] }, version, etag };
}

async function saveToDrive(userId, nextState, ifMatch) {
  const oauth2 = getOAuth2Client(userId);
  if (!oauth2) throw new Error("oauth_not_configured");
  if (!oauth2.credentials || !oauth2.credentials.access_token) throw new Error("not_linked");

  const { fileId, state, version, etag } = await loadFromDrive(userId);
  if (ifMatch && ifMatch !== etag) {
    return { conflict: true, current: { state, version, etag } };
  }
  const drive = getDriveClient(oauth2);
  const nextVersion = version + 1;
  const nextBody = { state: nextState ?? state, version: nextVersion };

  await drive.files.update({
    fileId,
    media: { mimeType: "application/json", body: JSON.stringify(nextBody) },
  });
  const newEtagStr = `"v${nextVersion}"`;
  return { ok: true, version: nextVersion, etag: newEtagStr };
}

/* ============ UTILS ============ */
// Lấy user-id linh hoạt: header 'x-user-id' hoặc query '?user='
function uidFromReq(req, res, isOptional = false) {
  const headerUid = req.get("x-user-id");
  const queryUid = req.query.user;
  const uid = headerUid || queryUid;
  if (!uid && !isOptional) {
    res.status(400).json({ error: "Missing x-user-id" });
    return null;
  }
  return uid ? String(uid) : null;
}

/* ============ OAUTH ENDPOINTS ============ */
// FE gọi để lấy URL liên kết Drive
app.get("/api/auth/url", (req, res) => {
  const userId = uidFromReq(req, res);
  if (!userId) return;

  const oauth2 = getOAuth2Client();
  if (!oauth2) return res.status(500).json({ error: "oauth_not_configured" });

  const scopes =
    DRIVE_MODE === "appDataFolder"
      ? ["https://www.googleapis.com/auth/drive.appdata"]
      : ["https://www.googleapis.com/auth/drive.file"];

  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
    state: encodeURIComponent(userId),
  });
  res.json({ url });
});

// Google redirect về đây (set trong Google Console)
app.get("/api/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    const state = decodeURIComponent(String(req.query.state || ""));
    if (!code || !state) return res.status(400).send("Missing code/state");

    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    saveUserToken(state, tokens);

    res
      .status(200)
      .send("✅ Kết nối Google Drive thành công. Bạn có thể đóng tab này.");
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth error");
  }
});

/* ============ HEALTH ============ */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ============ STATE APIS (Drive là nguồn chính, fallback local) ============ */
app.get("/api/state", async (req, res) => {
  const userId = uidFromReq(req, res, /*isOptional*/ true);

  if (REQUIRE_USER_LINK && !getUserToken(userId)) {
    return res.status(401).json({ error: "not_linked" });
  }

  if (userId && getUserToken(userId)) {
    try {
      const { state, version, etag } = await loadFromDrive(userId);
      res.set("ETag", etag);
      return res.json({ state, version });
    } catch (e) {
      if (String(e.message) === "not_linked") {
        if (REQUIRE_USER_LINK) return res.status(401).json({ error: "not_linked" });
      } else {
        console.error("loadFromDrive error:", e?.message || e);
      }
      // rơi xuống fallback local
    }
  }

  // Fallback local
  res.set("ETag", LOCAL_ETAG);
  res.json({ state: LOCAL_STATE, version: LOCAL_VERSION });
});

app.put("/api/state", async (req, res) => {
  if (API_KEY && req.get("x-api-key") !== API_KEY) {
    return res.status(403).json({ error: "forbidden" });
  }

  const userId = uidFromReq(req, res, /*isOptional*/ true);
  const ifMatch = req.get("If-Match") || "";
  const next = req.body.state;

  if (!next || typeof next !== "object") {
    return res.status(400).json({ error: "Invalid state" });
  }

  if (REQUIRE_USER_LINK && !getUserToken(userId)) {
    return res.status(401).json({ error: "not_linked" });
  }

  if (userId && getUserToken(userId)) {
    try {
      const saved = await saveToDrive(userId, next, ifMatch);
      if (saved?.conflict) {
        res.status(409).json({ error: "conflict", current: saved.current });
      } else {
        res.set("ETag", saved.etag);
        res.json({ ok: true, version: saved.version });
      }
      return;
    } catch (e) {
      if (String(e.message) === "not_linked") {
        if (REQUIRE_USER_LINK) return res.status(401).json({ error: "not_linked" });
      } else {
        console.error("saveToDrive error:", e?.message || e);
      }
      // rơi xuống fallback
    }
  }

  // Fallback local
  if (ifMatch && ifMatch !== LOCAL_ETAG) {
    return res.status(409).json({
      error: "conflict",
      current: { state: LOCAL_STATE, version: LOCAL_VERSION },
    });
  }
  LOCAL_STATE = next || LOCAL_STATE;
  LOCAL_VERSION += 1;
  LOCAL_ETAG = `"v${LOCAL_VERSION}"`;
  persistLocal();

  res.set("ETag", LOCAL_ETAG);
  res.json({ ok: true, version: LOCAL_VERSION });
});

/* ============ TÙY CHỌN: SAVE/LOAD THỦ CÔNG LÊN DRIVE ============ */
// ✅ ĐIỂM SỬA CHÍNH: nhận state từ body (nếu có) rồi ghi lên Drive.
//    Trước đây route này chỉ load lại state hiện có rồi ghi lại.
app.post("/api/drive/save", async (req, res) => {
  const userId = uidFromReq(req, res);
  if (!userId) return;

  if (!getUserToken(userId)) {
    return res.status(401).json({ ok: false, error: "Chưa kết nối Google Drive" });
  }

  try {
    const ifMatch = req.get("If-Match") || "";
    let nextState = req.body?.state; // <-- nhận từ FE

    // Nếu FE không gửi state, fallback sang state hiện có (để không lỗi).
    if (!nextState || typeof nextState !== "object") {
      try {
        const current = await loadFromDrive(userId);
        nextState = current.state;
      } catch {
        nextState = LOCAL_STATE;
      }
    }

    const saved = await saveToDrive(userId, nextState, ifMatch);
    if (saved?.conflict) {
      return res.status(409).json({ ok: false, error: "conflict", current: saved.current });
    }
    res.set("ETag", saved.etag);
    res.json({ ok: true, version: saved.version });
  } catch (e) {
    console.error("saveToDrive error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/drive/load", async (req, res) => {
  const userId = uidFromReq(req, res);
  if (!userId) return;

  if (!getUserToken(userId)) {
    return res.status(401).json({ ok: false, error: "Chưa kết nối Google Drive" });
  }

  try {
    const { state, version, etag } = await loadFromDrive(userId);
    res.set("ETag", etag);
    res.json({ ok: true, version, state });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ============ ROOTS ============ */
app.get("/", (_req, res) => res.send("MoneyTracker Sync Server running"));

/* ============ START ============ */
app.listen(PORT, () => {
  console.log("✅ sync-server running on", PORT);
  console.log("CORS allowed origins:", ALLOWED_ORIGINS.join(", "));
});

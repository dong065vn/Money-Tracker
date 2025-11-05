// server.js — ESM
// ===============================
// MoneyTracker Sync API + Google Drive (per-user) + SSE Realtime-ish
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

/* ============ CONFIG (.env) ============ */
const PORT = process.env.PORT || 3000;

// CORS: cho phép FE gọi (hỗ trợ nhiều origin, phân tách dấu phẩy)
const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://money-tracker-opal-sigma.vercel.app"
];
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || ""; // "https://app1.com,https://app2.com"
const EXTRA_ORIGINS = FRONTEND_ORIGIN
  ? FRONTEND_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
const ALLOWED_ORIGINS = Array.from(new Set([...DEFAULT_ORIGINS, ...EXTRA_ORIGINS]));

// (tùy chọn) API key khóa ghi server
const API_KEY = process.env.API_KEY || "";

// Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
// ví dụ: https://<your-domain>/api/oauth2callback
const OAUTH_REDIRECT_URL =
  process.env.GOOGLE_REDIRECT_URL || process.env.OAUTH_REDIRECT_URL || process.env.OAUTH_REDIRECT || "";

// Drive mode + policy
const DRIVE_MODE = process.env.DRIVE_MODE || "appDataFolder"; // "appDataFolder" | "drive"
const REQUIRE_USER_LINK = String(process.env.REQUIRE_USER_LINK || "false") === "true";

// Tên file lưu trên Drive
const DRIVE_FILE_PREFIX = process.env.DRIVE_FILE_PREFIX || ""; // ví dụ "moneytracker_"
const DRIVE_FILENAME_BASE = "moneytracker_state.json";

// Fallback tương thích ngược: dữ liệu local (chỉ dùng khi CHƯA liên kết)
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
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: false,
  })
);
// preflight
app.options("*", cors());

/* ============ SSE (Realtime-ish) ============ */
global.clients = {}; // userId => [res]

app.get("/api/stream", (req, res) => {
  const userId = uidFromReq(req, res);
  if (!userId) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (!global.clients[userId]) global.clients[userId] = [];
  global.clients[userId].push(res);

  // gửi ping giữ kết nối
  const timer = setInterval(() => {
    try { res.write("event: ping\ndata: {}\n\n"); } catch {}
  }, 25000);

  req.on("close", () => {
    clearInterval(timer);
    global.clients[userId] = (global.clients[userId] || []).filter(r => r !== res);
  });
});

function broadcastToUser(userId, payload) {
  const list = global.clients?.[userId] || [];
  for (const res of list) {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
  }
}

/* ============ LOCAL FALLBACK STORE (chỉ dùng khi CHƯA liên kết) ============ */
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
  // ignore nếu chưa có file
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
function deleteUserToken(userId) {
  const all = readTokens();
  if (all[userId]) {
    delete all[userId];
    writeTokens(all);
  }
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
function driveFilenameForUser(userId) {
  // Mỗi user một file riêng trong appData của Google Drive account
  return DRIVE_FILE_PREFIX
    ? `${DRIVE_FILE_PREFIX}${String(userId || "").replace(/[^\w.-]/g, "_")}.json`
    : DRIVE_FILENAME_BASE;
}

// Tìm (hoặc tạo) file của user
async function ensureUserFile(drive, userId) {
  const name = driveFilenameForUser(userId);
  const q =
    DRIVE_MODE === "appDataFolder"
      ? `name='${name}' and 'appDataFolder' in parents`
      : `name='${name}' and trashed=false`;

  const { data } = await drive.files.list({
    q,
    fields: "files(id, name, modifiedTime, md5Checksum)",
    spaces: DRIVE_MODE === "appDataFolder" ? "appDataFolder" : "drive"
  });
  if (data.files && data.files.length) return data.files[0];

  // Không tạo file mới khi lỗi OAuth (được chặn ở caller). Ở đây chỉ tạo khi tìm không thấy.
  const fileMeta =
    DRIVE_MODE === "appDataFolder"
      ? { name, parents: ["appDataFolder"] }
      : { name };

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
  try {
    const file = await ensureUserFile(drive, userId);
    const res = await drive.files.get(
      { fileId: file.id, alt: "media" },
      { responseType: "json" }
    );
    const body = res.data || { state: { members: [], transactions: [] }, version: 0 };
    const version = Number(body.version || 0);
    const etag = `"v${version}"`;
    return { fileId: file.id, state: body.state || { members: [], transactions: [] }, version, etag };
  } catch (e) {
    const msg = String(e?.message || "");
    // Nếu token hỏng → xóa token (ngắt liên kết), KHÔNG tạo file mới cho tới khi relink
    if (msg.includes("invalid_grant") || msg.includes("invalid_token")) {
      deleteUserToken(userId);
      throw new Error("not_linked");
    }
    throw e;
  }
}

async function saveToDrive(userId, nextState, ifMatch) {
  const oauth2 = getOAuth2Client(userId);
  if (!oauth2) throw new Error("oauth_not_configured");
  if (!oauth2.credentials || !oauth2.credentials.access_token) throw new Error("not_linked");

  try {
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

    // Realtime-ish broadcast
    broadcastToUser(userId, {
      type: "update",
      version: nextVersion,
      etag: newEtagStr,
      state: nextBody.state
    });

    return { ok: true, version: nextVersion, etag: newEtagStr };
  } catch (e) {
    const msg = String(e?.message || "");
    if (msg.includes("invalid_grant") || msg.includes("invalid_token")) {
      deleteUserToken(userId);
      throw new Error("not_linked");
    }
    throw e;
  }
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

  const scopes = [
    "https://www.googleapis.com/auth/drive.appdata",
    "https://www.googleapis.com/auth/drive.file"
  ];

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

    // Trả về HTML page với script để:
    // 1. Gửi message về parent window
    // 2. Tự động đóng popup sau 2s
    res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>OAuth Success</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .container {
            text-align: center;
            padding: 2rem;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            backdrop-filter: blur(10px);
            box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
          }
          .icon {
            font-size: 4rem;
            margin-bottom: 1rem;
            animation: checkmark 0.8s ease-in-out;
          }
          @keyframes checkmark {
            0% { transform: scale(0); }
            50% { transform: scale(1.2); }
            100% { transform: scale(1); }
          }
          h1 {
            margin: 0 0 0.5rem 0;
            font-size: 1.5rem;
          }
          p {
            margin: 0;
            opacity: 0.9;
            font-size: 0.9rem;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">✅</div>
          <h1>Kết nối thành công!</h1>
          <p>Cửa sổ này sẽ tự động đóng...</p>
        </div>
        <script>
          // Gửi message về parent window
          if (window.opener) {
            window.opener.postMessage({
              type: 'OAUTH_SUCCESS',
              provider: 'google-drive',
              userId: '${state}'
            }, '*');
          }

          // Tự động đóng sau 2 giây
          setTimeout(() => {
            window.close();
          }, 2000);
        </script>
      </body>
      </html>
    `);
  } catch (e) {
    console.error(e);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>OAuth Error</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
          }
          .container {
            text-align: center;
            padding: 2rem;
          }
          .icon { font-size: 4rem; margin-bottom: 1rem; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">❌</div>
          <h1>Lỗi kết nối</h1>
          <p>Vui lòng thử lại</p>
        </div>
        <script>
          if (window.opener) {
            window.opener.postMessage({
              type: 'OAUTH_ERROR',
              provider: 'google-drive'
            }, '*');
          }
          setTimeout(() => window.close(), 3000);
        </script>
      </body>
      </html>
    `);
  }
});

// ==== Auth status: FE hỏi xem user đã liên kết Drive chưa ====
app.get("/api/auth/status", (req, res) => {
  const userId = uidFromReq(req, res, /*isOptional*/ true);
  const linked = !!(userId && getUserToken(userId));
  return res.json({ ok: true, linked });
});

// ==== Reset token: NGẮT LIÊN KẾT (KHÔNG xóa file Drive) ====
app.post("/api/auth/reset", async (req, res) => {
  try {
    const userId = req.get("x-user-id");
    if (!userId) return res.status(400).json({ ok: false, error: "missing_user" });

    const tokens = getUserToken(userId);

    // Thử revoke với Google (không bắt buộc thành công)
    try {
      const oauth2 = getOAuth2Client(); // client rỗng, chỉ để gọi revoke
      if (tokens?.access_token) await oauth2.revokeToken(tokens.access_token).catch(() => {});
      if (tokens?.refresh_token) await oauth2.revokeToken(tokens.refresh_token).catch(() => {});
    } catch (_) {}

    // XÓA token trong tokens.json (QUAN TRỌNG). KHÔNG xóa file Drive.
    deleteUserToken(userId);

    console.log(`[auth/reset] removed token for user=${userId}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[auth/reset] error:", e);
    return res.status(500).json({ ok: false, error: "reset_failed" });
  }
});

/* ============ HEALTH ============ */
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* ============ STATE APIS (Drive là nguồn chính, fallback local khi CHƯA link) ============ */
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
      const msg = String(e?.message || "");
      console.error("loadFromDrive error:", msg);
      // KHÔNG fallback local nếu đã link — tránh ghi đè rỗng
      return res.status(502).json({ error: "drive_unavailable", detail: msg });
    }
  }

  // Chỉ khi CHƯA link Drive mới dùng local
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
        return res.status(409).json({ error: "conflict", current: saved.current });
      }
      res.set("ETag", saved.etag);
      return res.json({ ok: true, version: saved.version });
    } catch (e) {
      const msg = String(e?.message || "");
      console.error("saveToDrive error:", msg);
      // KHÔNG fallback local để tránh mất dữ liệu
      return res.status(502).json({ error: "drive_unavailable", detail: msg });
    }
  }

  // ---- Nhánh local: chỉ dùng cho user CHƯA link ----
  if (ifMatch && ifMatch !== LOCAL_ETAG) {
    return res.status(409).json({
      error: "conflict",
      current: { state: LOCAL_STATE, version: LOCAL_VERSION, etag: LOCAL_ETAG },
    });
  }
  LOCAL_STATE = next || LOCAL_STATE;
  LOCAL_VERSION += 1;
  LOCAL_ETAG = `"v${LOCAL_VERSION}"`;
  persistLocal();

  // broadcast local update (nếu dùng local mode)
  broadcastToUser(userId || "anonymous", {
    type: "update",
    version: LOCAL_VERSION,
    etag: LOCAL_ETAG,
    state: LOCAL_STATE
  });

  res.set("ETag", LOCAL_ETAG);
  res.json({ ok: true, version: LOCAL_VERSION });
});

/* ============ SAVE/LOAD THỦ CÔNG LÊN DRIVE ============ */
// SAVE: nhận state từ body rồi ghi lên Drive; nếu thiếu thì báo lỗi (KHÔNG đổ về local)
app.post("/api/drive/save", async (req, res) => {
  const userId = uidFromReq(req, res);
  if (!userId) return;

  if (!getUserToken(userId)) {
    return res.status(401).json({ ok: false, error: "not_linked" });
  }

  try {
    const ifMatch = req.get("If-Match") || "";
    const nextState = req.body?.state;
    if (!nextState || typeof nextState !== "object") {
      return res.status(400).json({ ok: false, error: "missing_state_body" });
    }

    const saved = await saveToDrive(userId, nextState, ifMatch);
    if (saved?.conflict) {
      return res.status(409).json({ ok: false, error: "conflict", current: saved.current });
    }
    res.set("ETag", saved.etag);
    res.json({ ok: true, version: saved.version });
  } catch (e) {
    const msg = String(e?.message || "");
    console.error("saveToDrive error:", msg);
    if (
      msg.includes("insufficientFilePermissions") ||
      msg.includes("The granted scopes do not give access")
    ) {
      return res.status(500).json({ ok: false, error: "missing_scope_drive_appdata" });
    }
    if (msg.includes("not_linked")) {
      return res.status(401).json({ ok: false, error: "not_linked" });
    }
    return res.status(500).json({ ok: false, error: msg || "save_failed" });
  }
});

app.get("/api/drive/load", async (req, res) => {
  const userId = uidFromReq(req, res);
  if (!userId) return;

  if (!getUserToken(userId)) {
    return res.status(401).json({ ok: false, error: "not_linked" });
  }

  try {
    const { state, version, etag } = await loadFromDrive(userId);
    res.set("ETag", etag);
    res.json({ ok: true, version, state });
  } catch (e) {
    const msg = String(e?.message || "");
    if (
      msg.includes("insufficientFilePermissions") ||
      msg.includes("The granted scopes do not give access")
    ) {
      return res.status(500).json({ ok: false, error: "missing_scope_drive_appdata" });
    }
    if (msg.includes("not_linked")) {
      return res.status(401).json({ ok: false, error: "not_linked" });
    }
    return res.status(500).json({ ok: false, error: msg || "load_failed" });
  }
});

/* ============ ROOTS ============ */
app.get("/", (_req, res) => res.send("MoneyTracker Sync Server running"));

/* ============ START ============ */
app.listen(PORT, () => {
  console.log("✅ sync-server running on", PORT);
  console.log("CORS allowed origins:");
  ALLOWED_ORIGINS.forEach((o) => console.log("  -", o));
});

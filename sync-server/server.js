// sync-server/server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// ====== Env / constants ======
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || ""; // để trống = public
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const OAUTH_REDIRECT_URL = process.env.OAUTH_REDIRECT_URL || "";
const DRIVE_MODE = process.env.DRIVE_MODE || "appDataFolder"; // "appDataFolder" | "drive"
const REQUIRE_USER_LINK = String(process.env.REQUIRE_USER_LINK || "false") === "true";

const LOCAL_DATA_FILE = path.join(__dirname, "data.json");      // fallback tương thích ngược
const TOKENS_FILE = path.join(__dirname, "tokens.json");        // lưu tokens theo user
const DRIVE_FILENAME = "moneytracker_state.json";               // 1 file / user

// ====== Compat-local state (y nguyên bản cũ) ======
let LOCAL_STATE = { members: [], transactions: [] };
let LOCAL_VERSION = 0;
let LOCAL_ETAG = `"v${LOCAL_VERSION}"`;

// nạp state từ file nếu có (y như code hiện tại)
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

// ====== Token storage helpers ======
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
  return all[userId] || null;
}
function saveUserToken(userId, tokens) {
  const all = readTokens();
  all[userId] = tokens;
  writeTokens(all);
}

// ====== Google OAuth / Drive ======
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

async function ensureUserFile(drive) {
  // tìm file theo tên; nếu appDataFolder, query theo parents=appDataFolder
  const q =
    DRIVE_MODE === "appDataFolder"
      ? `name='${DRIVE_FILENAME}' and 'appDataFolder' in parents`
      : `name='${DRIVE_FILENAME}' and trashed=false`;
  const { data } = await drive.files.list({
    q,
    fields: "files(id, name, modifiedTime, md5Checksum)"
  });
  if (data.files && data.files.length) return data.files[0];

  // chưa có → tạo file rỗng
  const fileMeta =
    DRIVE_MODE === "appDataFolder"
      ? { name: DRIVE_FILENAME, parents: ["appDataFolder"] }
      : { name: DRIVE_FILENAME };
  const media = {
    mimeType: "application/json",
    body: JSON.stringify({ state: { members: [], transactions: [] }, version: 0 })
  };
  const created = await drive.files.create({
    requestBody: fileMeta,
    media: { mimeType: "application/json", body: media.body },
    fields: "id, name, modifiedTime, md5Checksum"
  });
  return created.data;
}

async function loadFromDrive(userId) {
  const oauth2 = getOAuth2Client(userId);
  if (!oauth2) throw new Error("OAuth not configured");
  if (!oauth2.credentials || !oauth2.credentials.access_token) throw new Error("not_linked");

  const drive = getDriveClient(oauth2);
  const file = await ensureUserFile(drive);

  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "json" }
  );
  const body = res.data || { state: { members: [], transactions: [] }, version: 0 };

  const version = Number(body.version || 0);
  const etag = `"v${version}"`; // giữ cách ETag cũ dựa vào version

  return { fileId: file.id, state: body.state || { members: [], transactions: [] }, version, etag };
}

async function saveToDrive(userId, nextState, ifMatch) {
  const oauth2 = getOAuth2Client(userId);
  if (!oauth2) throw new Error("OAuth not configured");
  if (!oauth2.credentials || !oauth2.credentials.access_token) throw new Error("not_linked");

  const { fileId, state, version, etag } = await loadFromDrive(userId);
  if (ifMatch && ifMatch !== etag) {
    // trả dữ liệu hiện tại để client merge lại
    return { conflict: true, current: { state, version, etag } };
  }

  const drive = getDriveClient(oauth2);
  const nextVersion = version + 1;
  const nextBody = { state: nextState ?? state, version: nextVersion };

  await drive.files.update({
    fileId,
    media: { mimeType: "application/json", body: JSON.stringify(nextBody) }
  });
  const newEtag = `"v${nextVersion}"`;
  return { ok: true, version: nextVersion, etag: newEtag };
}

// ====== OAuth endpoints ======
// Trả URL để người dùng bấm liên kết
app.get("/api/auth/url", (req, res) => {
  const userId = req.get("x-user-id");
  if (!userId) return res.status(400).json({ error: "missing x-user-id" });
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
    state: encodeURIComponent(userId) // ánh xạ lại khi callback
  });
  res.json({ url });
});

// Callback Google redirect về
app.get("/api/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    const state = decodeURIComponent(String(req.query.state || ""));
    if (!code || !state) return res.status(400).send("Missing code/state");

    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    saveUserToken(state, tokens);

    res.status(200).send("✅ Kết nối Google Drive thành công. Bạn có thể đóng tab này.");
  } catch (e) {
    console.error(e);
    res.status(500).send("OAuth error");
  }
});

// ====== Health ======
app.get("/api/health", (_, res) => res.json({ ok: true }));

// ====== State APIs (giữ nguyên format cũ) ======
app.get("/api/state", async (req, res) => {
  const userId = req.get("x-user-id");

  // Nếu bắt buộc link và chưa link → báo lỗi
  if (REQUIRE_USER_LINK && !getUserToken(userId)) {
    return res.status(401).json({ error: "not_linked" });
  }

  // Nếu có token → lấy từ Drive
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
      // rơi xuống fallback
    }
  }

  // Fallback tương thích ngược (local JSON y như server cũ)
  res.set("ETag", LOCAL_ETAG);
  res.json({ state: LOCAL_STATE, version: LOCAL_VERSION });
});

app.put("/api/state", async (req, res) => {
  if (API_KEY && req.get("x-api-key") !== API_KEY) {
    return res.status(403).json({ error: "forbidden" });
  }

  const userId = req.get("x-user-id");
  const ifMatch = req.get("If-Match") || "";
  const next = req.body.state;

  // Nếu yêu cầu link mà chưa link → chặn
  if (REQUIRE_USER_LINK && !getUserToken(userId)) {
    return res.status(401).json({ error: "not_linked" });
  }

  // Nếu có token → ghi Drive
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

  // Fallback local JSON (y hệt server cũ)
  if (ifMatch && ifMatch !== LOCAL_ETAG) {
    return res.status(409).json({
      error: "conflict",
      current: { state: LOCAL_STATE, version: LOCAL_VERSION }
    });
  }
  // update
  LOCAL_STATE = next || LOCAL_STATE;
  LOCAL_VERSION += 1;
  LOCAL_ETAG = `"v${LOCAL_VERSION}"`;
  persistLocal();

  res.set("ETag", LOCAL_ETAG);
  res.json({ ok: true, version: LOCAL_VERSION });
});

app.listen(PORT, () => console.log("✅ sync-server running on", PORT));

// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();

/* ------------ Config ------------ */
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";

/* ------------ Middlewares ------------ */
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

// Preflight cho mọi route
app.options("*", cors());

// Logger đơn giản
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

/* ------------ In-memory store (demo) ------------ */
const userStore = new Map(); // userId -> { state, version, etag, tokens }
const DRIVE_FILENAME = "moneytracker_state.json";

function getUserSlot(userId) {
  if (!userStore.has(userId)) {
    userStore.set(userId, {
      state: { members: [], transactions: [] },
      version: 0,
      etag: makeEtag(0),
      tokens: null,
    });
  }
  return userStore.get(userId);
}
function makeEtag(version) {
  return `"v-${version}-${crypto.randomBytes(4).toString("hex")}"`;
}
function requireApiKey(req, res) {
  if (!API_KEY) return true;
  const k = req.header("x-api-key") || "";
  if (k === API_KEY) return true;
  res.status(401).json({ error: "invalid_api_key" });
  return false;
}

/* ------------ Google OAuth ------------ */
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID || "",
  process.env.GOOGLE_CLIENT_SECRET || "",
  process.env.GOOGLE_REDIRECT_URI || ""
);

// tạo URL OAuth, nhúng userId vào `state`
function buildAuthUrl(userId) {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive.appdata"],
    state: encodeURIComponent(userId || "anon"),
  });
}
function driveClientForTokens(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID || "",
    process.env.GOOGLE_CLIENT_SECRET || "",
    process.env.GOOGLE_REDIRECT_URI || ""
  );
  client.setCredentials(tokens);
  return google.drive({ version: "v3", auth: client });
}
async function findAppDataFile(drive) {
  const q = `name='${DRIVE_FILENAME}' and 'appDataFolder' in parents and trashed=false`;
  const r = await drive.files.list({
    spaces: "appDataFolder",
    q,
    fields: "files(id,name)",
    pageSize: 1,
  });
  return r.data.files?.[0] || null;
}

/* ------------ Routes: OAuth ------------ */
// FE gọi để lấy URL đăng nhập (FE phải gửi x-user-id)
app.get("/api/auth/url", (req, res) => {
  const userId = req.header("x-user-id") || "anon";
  try {
    const url = buildAuthUrl(userId);
    return res.json({ url });
  } catch (e) {
    console.error("auth_url_error", e);
    return res.status(500).json({ error: "auth_url_failed" });
  }
});

// Google redirect về đây (kèm `state=userId`)
app.get("/api/auth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const state = decodeURIComponent(String(req.query.state || "anon"));
    if (!code) return res.status(400).send("Missing code");
    const { tokens } = await oauth2Client.getToken(code);
    const slot = getUserSlot(state);
    slot.tokens = tokens;
    res.send(
      `<html><body style="font-family:system-ui">
       <h3>Đã kết nối Google Drive ✅</h3>
       <p>Bạn có thể đóng tab này.</p>
       </body></html>`
    );
  } catch (e) {
    console.error("auth_callback_error", e);
    res.status(500).send("Auth failed");
  }
});

/* ------------ Routes: State sync core ------------ */
app.get("/api/state", (req, res) => {
  const userId = req.header("x-user-id") || "anon";
  const slot = getUserSlot(userId);
  res.setHeader("ETag", slot.etag);
  res.json({ state: slot.state, version: slot.version });
});

app.put("/api/state", (req, res) => {
  if (!requireApiKey(req, res)) return;
  const userId = req.header("x-user-id") || "anon";
  const slot = getUserSlot(userId);

  const ifMatch = req.header("If-Match");
  if (ifMatch && ifMatch !== slot.etag) {
    return res.status(409).json({
      error: "conflict",
      current: { state: slot.state, version: slot.version, etag: slot.etag },
    });
  }

  slot.state = req.body?.state || { members: [], transactions: [] };
  slot.version += 1;
  slot.etag = makeEtag(slot.version);

  res.setHeader("ETag", slot.etag);
  res.json({ ok: true, version: slot.version });
});

/* ------------ Routes: Drive save/load ------------ */
// LƯU (POST) – FE có thể gửi {state} trong body (nếu muốn), hoặc server dùng state đang có.
app.post("/api/drive/save", async (req, res) => {
  const userId = req.header("x-user-id") || "anon";
  const slot = getUserSlot(userId);

  if (!slot.tokens) return res.status(401).json({ error: "not_connected" });

  // update slot nếu FE gửi bản mới
  if (req.body && typeof req.body.state === "object") {
    slot.state = req.body.state;
    slot.version += 1;
    slot.etag = makeEtag(slot.version);
  }

  try {
    const drive = driveClientForTokens(slot.tokens);
    const body = Buffer.from(JSON.stringify(slot.state || {}, null, 2), "utf8");
    const existing = await findAppDataFile(drive);
    if (existing) {
      await drive.files.update({
        fileId: existing.id,
        media: { mimeType: "application/json", body },
      });
    } else {
      await drive.files.create({
        media: { mimeType: "application/json", body },
        requestBody: { name: DRIVE_FILENAME, parents: ["appDataFolder"] },
        fields: "id",
      });
    }
    res.json({ ok: true, version: slot.version, etag: slot.etag });
  } catch (e) {
    console.error("drive_save_error", e?.response?.data || e);
    res.status(500).json({ error: "drive_save_failed" });
  }
});

// Nếu FE lỡ gọi GET /api/drive/save -> trả lời rõ ràng (tránh 404 gây hiểu nhầm)
app.get("/api/drive/save", (_req, res) => {
  res.status(405).json({ error: "use_POST_here" });
});

// TẢI (GET) – đọc appDataFolder, update slot & trả state
app.get("/api/drive/load", async (req, res) => {
  const userId = req.header("x-user-id") || "anon";
  const slot = getUserSlot(userId);

  if (!slot.tokens) return res.status(401).json({ error: "not_connected" });

  try {
    const drive = driveClientForTokens(slot.tokens);
    const existing = await findAppDataFile(drive);
    if (!existing) return res.json({ state: null, message: "no_file" });

    const resp = await drive.files.get(
      { fileId: existing.id, alt: "media" },
      { responseType: "arraybuffer" }
    );
    const buf = Buffer.from(resp.data);
    const json = JSON.parse(buf.toString("utf8") || "{}");

    slot.state = json;
    slot.version += 1;
    slot.etag = makeEtag(slot.version);

    res.setHeader("ETag", slot.etag);
    res.json({ state: slot.state, version: slot.version });
  } catch (e) {
    console.error("drive_load_error", e?.response?.data || e);
    res.status(500).json({ error: "drive_load_failed" });
  }
});

/* ------------ Health ------------ */
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ------------ Start ------------ */
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});

import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());                 // hoặc cors({ origin: true })
app.use(express.json());

let STATE = { members: [], transactions: [] };
let VERSION = 0;
let ETAG = `"v${VERSION}"`;

const API_KEY = process.env.API_KEY || ''; // set trên Render

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  res.set('ETag', ETAG);
  res.json({ state: STATE, version: VERSION });
});

app.put('/api/state', (req, res) => {
  if (API_KEY && req.get('x-api-key') !== API_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const ifMatch = req.get('If-Match') || '';
  if (ifMatch && ifMatch !== ETAG) {
    return res.status(409).json({ error: 'conflict', current: { state: STATE, version: VERSION } });
  }
  STATE = req.body.state || STATE;
  VERSION += 1;
  ETAG = `"v${VERSION}"`;
  res.set('ETag', ETAG);
  res.json({ ok: true, version: VERSION });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('sync server listening on', PORT);
});

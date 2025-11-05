// src/App.jsx
import React, { useEffect, useMemo, useState, useRef, useCallback } from "react";
import toast, { Toaster } from "react-hot-toast";

/* ===== ENV & SYNC ===== */
const SYNC_URL = import.meta.env.VITE_SYNC_URL;
const SYNC_KEY = import.meta.env.VITE_SYNC_KEY;
const SYNC_PULL_MS = Number(import.meta.env.VITE_SYNC_PULL_MS || 5000);

/* ===== USER ID (ổn định per-user) ===== */
const USER_ID = (() => {
  const KEY = "mt_userId";
  let v = localStorage.getItem(KEY);
  if (!v) {
    v = crypto?.randomUUID?.() ?? `user-${Date.now()}`;
    localStorage.setItem(KEY, v);
  }
  return v;
})();

/* ===== Utils ===== */
const toInt = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Math.trunc(v);
  const n = parseInt(String(v).replace(/[^\d-]/g, "") || "0", 10);
  return isNaN(n) ? 0 : Math.trunc(n);
};
const toVND = (n) =>
  (n ?? 0).toLocaleString("vi-VN", { maximumFractionDigits: 0 }) + " ₫";

// save khi rảnh (khỏi block UI)
const idle = (fn) =>
  (window.requestIdleCallback ? window.requestIdleCallback(fn) : setTimeout(fn, 0));

// Confirmation dialog helper
const confirmAction = (message) => {
  return new Promise((resolve) => {
    toast((t) => (
      <div className="flex flex-col gap-3">
        <p className="text-sm">{message}</p>
        <div className="flex gap-2 justify-end">
          <button
            className="px-3 py-1.5 text-xs rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors"
            onClick={() => {
              toast.dismiss(t.id);
              resolve(false);
            }}
          >
            Hủy
          </button>
          <button
            className="px-3 py-1.5 text-xs rounded-lg bg-red-600 hover:bg-red-500 transition-colors"
            onClick={() => {
              toast.dismiss(t.id);
              resolve(true);
            }}
          >
            Xác nhận
          </button>
        </div>
      </div>
    ), { duration: Infinity });
  });
};

/* ===== Split & Balance (Upgraded) ===== */

// Chia đều, phân phối dư công bằng
function splitEqual(total, parts) {
  if (!parts.length) return {};
  const avg = total / parts.length;
  const base = Math.floor(avg);
  let remainder = total - base * parts.length;
  const out = {};
  parts.forEach((p, i) => {
    out[p] = base + (i < remainder ? 1 : 0);
  });
  return out;
}

// Chia theo shares/weights/equal
function computeShares(tx) {
  const total = toInt(tx.total);
  const ps = tx.participants || [];
  if (!ps.length) return {};

  // Explicit: nhập số tiền từng người
  if (tx.mode === "explicit" && tx.shares) {
    const out = {};
    ps.forEach((u) => (out[u] = Math.max(0, toInt(tx.shares[u]))));
    let diff = total - Object.values(out).reduce((a, b) => a + b, 0);
    // Điều chỉnh dư/thừa để tổng chính xác
    const keys = Object.keys(out);
    for (let i = 0; i < keys.length && diff !== 0; i++) {
      out[keys[i]] += diff > 0 ? 1 : -1;
      diff += diff > 0 ? -1 : 1;
    }
    return out;
  }

  // Weights: largest-remainder method
  if (tx.mode === "weights" && tx.weights) {
    const weights = ps.map((u) => Math.max(0, Number(tx.weights[u] || 0)));
    const sumW = weights.reduce((a, b) => a + b, 0);
    if (!sumW) return splitEqual(total, ps);

    const raw = weights.map((w) => (w / sumW) * total);
    const base = raw.map(Math.floor);
    let remainder = total - base.reduce((a, b) => a + b, 0);

    const frac = raw
      .map((x, i) => ({ i, f: x - base[i] }))
      .sort((a, b) => b.f - a.f);
    for (let k = 0; k < remainder; k++) base[frac[k].i]++;

    const out = {};
    ps.forEach((u, i) => (out[u] = base[i]));
    return out;
  }

  // Equal
  return splitEqual(total, ps);
}

// Tính số dư (credit/debit) + log nợ theo từng giao dịch
function computeBalancesAndOwes(transactions) {
  const balances = {};
  const owes = [];

  for (const tx of transactions) {
    const total = toInt(tx.total);
    const shares = computeShares(tx);

    // Payer chính + danh sách đã trả (multi-payer)
    const payers = [tx.payer, ...(tx.paid || [])].filter(Boolean);
    if (!payers.length) continue;

    // Tổng đã trả phân đều cho payers
    const payPer = total / payers.length;

    payers.forEach((u) => (balances[u] = (balances[u] || 0) + payPer));

    for (const [uidStr, share] of Object.entries(shares)) {
      const uid = Number(uidStr);
      balances[uid] = (balances[uid] || 0) - share;
      if (share > 0 && !payers.includes(uid)) {
        owes.push({ from: uid, to: tx.payer, amount: share, tx: tx.id });
      }
    }
  }

  return { balances, owes };
}

// Thuật toán tối ưu số giao dịch (Minimize Cash Flow)
function settleMinCashFlow(balances) {
  const debtors = [];
  const creditors = [];
  Object.entries(balances).forEach(([id, bal]) => {
    if (bal < 0) debtors.push({ id, amt: -bal });
    else if (bal > 0) creditors.push({ id, amt: bal });
  });

  const res = [];
  let i = 0,
    j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i],
      c = creditors[j];
    const settle = Math.min(d.amt, c.amt);
    if (settle > 0) res.push({ from: d.id, to: c.id, amount: settle });
    d.amt -= settle;
    c.amt -= settle;
    if (d.amt === 0) i++;
    if (c.amt === 0) j++;
  }
  return res;
}

/* ===== LocalStorage (giữ offline) ===== */
const LS_MEMBERS = "mt_members_v2";
const LS_TXS = "mt_transactions_v2";
const loadMembers = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_MEMBERS) || "[]");
  } catch {
    return [];
  }
};
const saveMembers = (arr) => localStorage.setItem(LS_MEMBERS, JSON.stringify(arr));
const loadTxs = () => {
  try {
    return JSON.parse(localStorage.getItem(LS_TXS) || "[]");
  } catch {
    return [];
  }
};
const saveTxs = (arr) => localStorage.setItem(LS_TXS, JSON.stringify(arr));

/* ===== Sync helpers (FE <-> BE) ===== */
async function pullRemote() {
  if (!SYNC_URL) return null;
  const res = await fetch(`${SYNC_URL}/api/state`, {
    headers: { "x-user-id": USER_ID },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error("pull failed");
  const etag = res.headers.get("ETag");
  const json = await res.json();
  return { ...json, etag };
}
async function pushRemote(state, etag) {
  if (!SYNC_URL) return null;
  const res = await fetch(`${SYNC_URL}/api/state`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": SYNC_KEY || "",
      "If-Match": etag ?? "",
      "x-user-id": USER_ID,
    },
    body: JSON.stringify({ state }),
  });
  if (res.status === 401) return null;
  if (res.status === 409)
    return { conflict: true, current: (await res.json()).current };
  if (!res.ok) throw new Error("push failed");
  const newEtag = res.headers.get("ETag");
  const data = await res.json();
  return { ...data, etag: newEtag };
}

/* ===== Error Boundary ===== */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
    toast.error('Đã xảy ra lỗi! Vui lòng tải lại trang.');
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-slate-900 rounded-2xl border border-slate-700 p-8 text-center">
            <div className="h-16 w-16 mx-auto mb-4 rounded-full bg-red-900/30 flex items-center justify-center">
              <svg className="h-8 w-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold mb-2">Oops! Đã có lỗi xảy ra</h2>
            <p className="text-slate-400 mb-6">Ứng dụng gặp sự cố không mong muốn.</p>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center px-6 py-3 bg-indigo-600 hover:bg-indigo-700 rounded-xl text-sm font-medium transition-colors"
            >
              Tải lại trang
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/* ===== UI atoms ===== */
function Button({
  children,
  onClick,
  variant = "primary",
  className = "",
  type = "button",
  title,
  disabled = false,
}) {
  const base =
    "inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transform active:scale-95 shadow-sm";
  const map = {
    primary:
      "bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white focus:ring-indigo-300 focus:ring-offset-slate-900 shadow-indigo-900/50",
    ghost:
      "bg-transparent border border-slate-700 hover:bg-slate-800/80 hover:border-slate-600 text-slate-100 focus:ring-cyan-300 focus:ring-offset-slate-900",
    danger:
      "bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 text-white focus:ring-rose-300 focus:ring-offset-slate-900 shadow-rose-900/50",
    subtle:
      "bg-slate-800 text-slate-100 border border-slate-700 hover:bg-slate-700 hover:border-slate-600 focus:ring-cyan-300 focus:ring-offset-slate-900",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={`${base} ${map[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
function Input({ label, value, onChange, placeholder, type = "text" }) {
  return (
    <label className="space-y-1.5 block">
      <span className="text-xs font-medium text-slate-300">{label}</span>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full px-3 py-2.5 text-sm rounded-xl bg-slate-900/70 border border-slate-700 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-400/70 transition-all duration-200 hover:border-slate-600"
      />
    </label>
  );
}
function Select({ label, value, onChange, children }) {
  return (
    <label className="space-y-1.5 block">
      <span className="text-xs font-medium text-slate-300">{label}</span>
      <select
        value={value}
        onChange={onChange}
        className="w-full px-3 py-2.5 text-sm rounded-xl bg-slate-900/70 border border-slate-700 text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-400/70 transition-all duration-200 hover:border-slate-600 cursor-pointer"
      >
        {children}
      </select>
    </label>
  );
}
function Card({ title, action, children }) {
  return (
    <section className="group rounded-3xl border border-slate-700/50 bg-gradient-to-br from-slate-900/40 via-slate-900/30 to-slate-800/40 shadow-2xl shadow-black/40 backdrop-blur-xl transition-all duration-300 hover:shadow-indigo-500/10 hover:shadow-3xl hover:border-indigo-500/30 hover:scale-[1.01]">
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/40 bg-gradient-to-r from-slate-800/40 to-slate-900/40 rounded-t-3xl">
        <h2 className="text-sm font-bold text-transparent bg-clip-text bg-gradient-to-r from-slate-100 to-slate-300 tracking-tight flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400 group-hover:scale-150 transition-transform duration-300"></span>
          {title}
        </h2>
        {action}
      </div>
      <div className="p-6">{children}</div>
    </section>
  );
}

/* ===== App ===== */
function App() {
  const pageBg = "bg-slate-950";
  const pageText = "text-slate-100";

  const [members, setMembers] = useState(() => {
    const local = loadMembers();
    if (Array.isArray(local) && local.length) return local;
    return [
      { id: 1, name: "Đông", color: "#4f46e5" },
      { id: 2, name: "Thế Anh", color: "#06b6d4" },
    ];
  });
  const [memberInput, setMemberInput] = useState("");
  const [txs, setTxs] = useState(() => loadTxs());

  const [etag, setEtag] = useState(null);
  const [version, setVersion] = useState(0);

  // ref phục vụ auto-save thông minh
  const lastPushedRef = useRef(""); // JSON đã push gần nhất
  const etagRef = useRef(etag);
  useEffect(() => { etagRef.current = etag; }, [etag]);

  /* === Summary (linh hoạt) state === */
  const [summaryOnlySelected, setSummaryOnlySelected] = useState(false);
  const [summarySelectedIds, setSummarySelectedIds] = useState([]); // ids của tx được chọn
  const [summaryFrom, setSummaryFrom] = useState(""); // yyyy-mm-dd
  const [summaryTo, setSummaryTo] = useState("");     // yyyy-mm-dd

  /* === Loading states === */
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | syncing | success | error

  /* persist local (nhẹ UI) */
  useEffect(() => { idle(() => saveMembers(members)); }, [members]);
  useEffect(() => { idle(() => saveTxs(txs)); }, [txs]);

  /* initial pull */
  useEffect(() => {
    (async () => {
      try {
        const remote = await pullRemote();
        if (remote?.state) {
          setMembers(
            Array.isArray(remote.state.members) ? remote.state.members : members
          );
          setTxs(
            Array.isArray(remote.state.transactions)
              ? remote.state.transactions
              : txs
          );
          setVersion(remote.version || 0);
          setEtag(remote.etag || null);
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* auto-save (debounce + chống push thừa) */
  const stateObj = useMemo(() => ({ members, transactions: txs }), [members, txs]);
  useEffect(() => {
    const to = setTimeout(async () => {
      try {
        const json = JSON.stringify(stateObj);
        // 1) nếu state chưa đổi so với lần push gần nhất => bỏ qua
        if (json === lastPushedRef.current) return;

        // 2) push với etag mới nhất
        const pushed = await pushRemote(stateObj, etagRef.current);
        if (pushed?.conflict) {
          const remote = await pullRemote();
          if (remote?.state) {
            setMembers(remote.state.members ?? []);
            setTxs(remote.state.transactions ?? []);
            setVersion(remote.version || 0);
            setEtag(remote.etag || null);
          }
        } else if (pushed?.etag) {
          setVersion(pushed.version ?? version + 1);
          setEtag(pushed.etag);
          lastPushedRef.current = json;
        }
      } catch {}
    }, 400);
    return () => clearTimeout(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateObj]);

  /* polling (fallback) */
  useEffect(() => {
    if (!SYNC_URL) return;
    const t = setInterval(async () => {
      try {
        const remote = await pullRemote();
        if (remote && remote.version > version) {
          setMembers(remote.state.members ?? []);
          setTxs(remote.state.transactions ?? []);
          setVersion(remote.version);
          setEtag(remote.etag || null);
        }
      } catch {}
    }, SYNC_PULL_MS);
    return () => clearInterval(t);
  }, [version]);

  /* realtime (SSE) — chỉ nhận version mới hơn để tránh 'nhảy' state */
  useEffect(() => {
    if (!SYNC_URL) return;
    const ev = new EventSource(
      `${SYNC_URL}/api/stream?user=${encodeURIComponent(USER_ID)}`
    );
    ev.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg?.type === "update") {
          if (typeof msg.version === "number" && msg.version <= version) return;
          setMembers(Array.isArray(msg.state?.members) ? msg.state.members : []);
          setTxs(Array.isArray(msg.state?.transactions) ? msg.state.transactions : []);
          setVersion(typeof msg.version === "number" ? msg.version : 0);
          setEtag(msg.etag || null);
        }
      } catch {}
    };
    ev.onerror = () => {}; // để polling xử lý dự phòng
    return () => ev.close();
  }, [version]);

  /* Listen for OAuth popup messages (tránh form bị nhảy khi đăng nhập Gmail) */
  useEffect(() => {
    const handleMessage = async (event) => {
      // Security: Chỉ nhận message từ popup OAuth
      // Note: Trong production nên check event.origin
      if (!event.data || typeof event.data !== 'object') return;

      if (event.data.type === 'OAUTH_SUCCESS' && event.data.provider === 'google-drive') {
        toast.success('🎉 Đã kết nối Google Drive thành công!');

        // Tự động load dữ liệu từ Drive sau khi kết nối
        try {
          await loadFromDrive();
        } catch (err) {
          console.error('Auto-load from Drive failed:', err);
        }
      } else if (event.data.type === 'OAUTH_ERROR') {
        toast.error('❌ Không thể kết nối Google Drive. Vui lòng thử lại.');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [loadFromDrive]); // dependency: loadFromDrive callback

  /* derived */
  const idToName = useMemo(
    () => new Map(members.map((x) => [x.id, x.name])),
    [members]
  );
  const normalizedTxs = useMemo(
    () =>
      txs.map((t) => ({
        ...t,
        participants: (t.participants || []).filter((pid) =>
          members.some((m) => m.id === pid)
        ),
        payer: members.some((m) => m.id === t.payer)
          ? t.payer
          : members[0]?.id ?? 0,
        paid: Array.isArray(t.paid)
          ? t.paid.filter((pid) => members.some((m) => m.id === pid))
          : [],
        total: toInt(t.total),
      })),
    [txs, members]
  );
  const { balances } = useMemo(
    () => computeBalancesAndOwes(normalizedTxs),
    [normalizedTxs]
  );
  const balancesList = useMemo(
    () =>
      Object.entries(balances)
        .map(([id, amt]) => ({
          id: Number(id),
          name: idToName.get(Number(id)) ?? `#${id}`,
          amount: amt,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [balances, idToName]
  );
  const nameBalances = useMemo(() => {
    const obj = {};
    balancesList.forEach((b) => (obj[b.name] = b.amount));
    return obj;
  }, [balancesList]);
  const transfers = useMemo(
    () => settleMinCashFlow(nameBalances),
    [nameBalances]
  );
  const totalCheck = useMemo(
    () => Object.values(balances).reduce((a, b) => a + b, 0),
    [balances]
  );
  const spentByPayer = useMemo(() => {
    const map = new Map();
    normalizedTxs.forEach((t) =>
      map.set(t.payer, (map.get(t.payer) || 0) + toInt(t.total))
    );
    return members.map((m) => ({ id: m.id, name: m.name, total: map.get(m.id) || 0 }));
  }, [normalizedTxs, members]);

  // ===== Derived cho TAB "Tổng kết" linh hoạt =====
  const summaryTxs = useMemo(() => {
    const from = summaryFrom ? new Date(summaryFrom + "T00:00:00") : null;
    const to = summaryTo ? new Date(summaryTo + "T23:59:59") : null;
    return normalizedTxs.filter((t) => {
      if (summaryOnlySelected && !summarySelectedIds.includes(t.id)) return false;
      const ts = new Date(t.ts);
      if (from && ts < from) return false;
      if (to && ts > to) return false;
      return true;
    });
  }, [normalizedTxs, summaryOnlySelected, summarySelectedIds, summaryFrom, summaryTo]);

  const { balances: summaryBalances } = useMemo(
    () => computeBalancesAndOwes(summaryTxs),
    [summaryTxs]
  );
  const summaryNameBalances = useMemo(() => {
    const obj = {};
    Object.entries(summaryBalances).forEach(([id, amt]) => {
      obj[idToName.get(Number(id)) ?? `#${id}`] = amt;
    });
    return obj;
  }, [summaryBalances, idToName]);
  const summaryTransfers = useMemo(
    () => settleMinCashFlow(summaryNameBalances),
    [summaryNameBalances]
  );
  const summaryTotalCheck = useMemo(
    () => Object.values(summaryBalances).reduce((a, b) => a + b, 0),
    [summaryBalances]
  );

  /* actions: members (useCallback để giảm re-render) */
  const addMember = useCallback(() => {
    const name = memberInput.trim();
    if (!name) return;
    if (members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      setMemberInput("");
      return;
    }
    const colors = [
      "#4f46e5",
      "#22d3ee",
      "#06b6d4",
      "#0ea5e9",
      "#a78bfa",
      "#6366f1",
      "#2dd4bf",
      "#38bdf8",
    ];
    const color = colors[members.length % colors.length];
    setMembers([...members, { id: Date.now(), name, color }]);
    setMemberInput("");
  }, [memberInput, members]);

  const removeMember = useCallback(async (id) => {
    const confirmed = await confirmAction("Xóa thành viên này?");
    if (!confirmed) return;
    const next = members.filter((m) => m.id !== id);
    setMembers(next);
    const keepIds = new Set(next.map((m) => m.id));
    setTxs((arr) =>
      arr.map((t) => {
        const p = (t.participants || []).filter(
          (pid) => pid !== id && keepIds.has(pid)
        );
        const paid = (t.paid || []).filter(
          (pid) => pid !== id && keepIds.has(pid)
        );
        const patch = {
          ...t,
          participants: p,
          paid,
          payer: t.payer === id ? p[0] ?? next[0]?.id ?? 0 : t.payer,
        };
        if (t.mode === "weights" && t.weights) {
          const w = { ...t.weights };
          delete w[id];
          patch.weights = w;
        }
        if (t.mode === "explicit" && t.shares) {
          const s = { ...t.shares };
          delete s[id];
          patch.shares = s;
        }
        return patch;
      })
    );
  }, [members]);

  const removeUnusedMembers = useCallback(async () => {
    const used = new Set();
    normalizedTxs.forEach((t) => {
      used.add(t.payer);
      (t.participants || []).forEach((id) => used.add(id));
    });
    const keep = members.filter((m) => used.has(m.id));
    if (keep.length === members.length) {
      toast.error("Không có thành viên thừa.");
      return;
    }
    const confirmed = await confirmAction(`Xóa ${members.length - keep.length} thành viên không thuộc giao dịch?`);
    if (confirmed) setMembers(keep);
  }, [members, normalizedTxs]);

  /* actions: transactions */
  const [payerDraft, setPayerDraft] = useState(0);
  const [totalDraft, setTotalDraft] = useState("");
  const [participantsDraft, setParticipantsDraft] = useState([]);
  const [modeDraft, setModeDraft] = useState("equal");
  const [weightsDraft, setWeightsDraft] = useState({});
  const [sharesDraft, setSharesDraft] = useState({});
  const [noteDraft, setNoteDraft] = useState("");
  useEffect(() => {
    if (!payerDraft && members[0]?.id) setPayerDraft(members[0].id);
    if (participantsDraft.length === 0)
      setParticipantsDraft(members.map((m) => m.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.length]);
  const toggleParticipantDraft = useCallback((id) =>
    setParticipantsDraft((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    ), []);
  const onWeightDraftChange = useCallback((id, v) =>
    setWeightsDraft((w) => ({ ...w, [id]: Number(v) })), []);
  const onShareDraftChange = useCallback((id, v) =>
    setSharesDraft((s) => ({ ...s, [id]: toInt(v) })), []);

  const addTransaction = useCallback(() => {
    const total = toInt(totalDraft);
    const parts = participantsDraft.filter((pid) =>
      members.some((m) => m.id === pid)
    );
    if (!payerDraft || !members.some((m) => m.id === payerDraft)) {
      toast.error("Payer không hợp lệ.");
      return;
    }
    if (total <= 0) {
      toast.error("Total phải > 0.");
      return;
    }
    if (parts.length === 0) {
      toast.error("Chọn ít nhất 1 participant.");
      return;
    }

    const tx = {
      id: (crypto?.randomUUID?.() ?? `T${Date.now()}`), // ID ổn định/ít đụng
      payer: payerDraft,
      total,
      participants: parts,
      mode: modeDraft,
      note: noteDraft.trim(),
      ts: new Date().toISOString(),
      paid: [],
      ...(modeDraft === "weights" ? { weights: { ...weightsDraft } } : {}),
      ...(modeDraft === "explicit" ? { shares: { ...sharesDraft } } : {}),
    };
    const shares = computeShares(tx);
    const sum = Object.values(shares).reduce((a, b) => a + b, 0);
    if (sum !== total) {
      toast.error("Shares <> total. Kiểm tra lại.");
      return;
    }

    setTxs((arr) => [tx, ...arr]);

    // Show success message
    toast.success("Đã thêm giao dịch!");

    // Reset only total and note - keep payer, participants, and mode for convenience
    setTotalDraft("");
    setNoteDraft("");
    // Only reset weights/shares if mode changes
    if (modeDraft === "weights") setWeightsDraft({});
    if (modeDraft === "explicit") setSharesDraft({});
    // Keep: payerDraft, participantsDraft, modeDraft
  }, [totalDraft, participantsDraft, members, payerDraft, modeDraft, noteDraft, weightsDraft, sharesDraft]);

  const removeTx = useCallback(async (id) => {
    const confirmed = await confirmAction("Xóa giao dịch này?");
    if (confirmed) {
      setTxs((arr) => arr.filter((t) => t.id !== id));
      toast.success("Đã xóa giao dịch!");
    }
  }, []);

  const resetForm = useCallback(() => {
    setPayerDraft(members[0]?.id || 0);
    setTotalDraft("");
    setNoteDraft("");
    setModeDraft("equal");
    setWeightsDraft({});
    setSharesDraft({});
    setParticipantsDraft(members.map((m) => m.id));
    toast.success("Đã reset form!");
  }, [members]);

  const togglePaid = useCallback((txId, memberId) => {
    setTxs((prev) =>
      prev.map((t) => {
        if (
          t.id !== txId ||
          memberId === t.payer ||
          !(t.participants || []).includes(memberId)
        )
          return t;
        const set = new Set(t.paid || []);
        set.has(memberId) ? set.delete(memberId) : set.add(memberId);
        return { ...t, paid: [...set] };
      })
    );
  }, []);

  /* export / import */
  const downloadJSON = useCallback(() => {
    const blob = new Blob(
      [JSON.stringify({ members, transactions: txs }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "moneytracker_backup.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [members, txs]);

  const importJSON = useCallback((ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (Array.isArray(data.members)) setMembers(data.members);
        if (Array.isArray(data.transactions)) setTxs(data.transactions);
        toast.success("Import thành công!");
      } catch {
        toast.error("File không hợp lệ");
      }
    };
    r.readAsText(f);
  }, []);

  const exportCSV = useCallback(() => {
    const rows = [
      ["ID", "Time", "Payer", "Total(VND)", "Mode", "Participants", "Paid", "Note"],
    ];
    for (const t of txs) {
      const payer = idToName.get(t.payer) ?? t.payer;
      const parts = (t.participants || [])
        .map((id) => idToName.get(id) ?? id)
        .join("; ");
      const paid = (t.paid || [])
        .map((id) => idToName.get(id) ?? id)
        .join("; ");
      rows.push([
        t.id,
        new Date(t.ts).toLocaleString("vi-VN"),
        payer,
        toInt(t.total),
        t.mode,
        parts,
        paid,
        t.note || "",
      ]);
    }
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "moneytracker_transactions.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [txs, idToName]);

  /* Drive OAuth & Sync (manual) */
  const connectDrive = useCallback(async () => {
    if (!SYNC_URL) {
      toast.error("Chưa cấu hình VITE_SYNC_URL");
      return;
    }
    try {
      const r = await fetch(
        `${SYNC_URL}/api/auth/url?user=${encodeURIComponent(USER_ID)}`,
        { headers: { "x-user-id": USER_ID } }
      );
      const { url } = await r.json();
      if (url) {
        window.open(url, "_blank", "width=520,height=640");
        toast("🔐 Đang mở cửa sổ đăng nhập Google...", {
          icon: '🚀',
          duration: 3000
        });
      } else {
        toast.error("Không lấy được URL liên kết");
      }
    } catch {
      toast.error("Không thể kết nối Google Drive");
    }
  }, []);

  const resetDrive = useCallback(async () => {
    if (!SYNC_URL) {
      toast.error("Chưa cấu hình VITE_SYNC_URL");
      return;
    }
    const confirmed = await confirmAction("Ngắt liên kết Google Drive cho tài khoản này?");
    if (!confirmed) return;
    try {
      const r = await fetch(`${SYNC_URL}/api/auth/reset`, {
        method: "POST",
        headers: { "x-user-id": USER_ID },
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || out?.ok === false) {
        toast.error("Không thể ngắt liên kết: " + (out?.error || `(${r.status})`));
        return;
      }
      toast.success("Đã ngắt liên kết. Bấm 'Kết nối Google Drive' để cấp lại quyền.");
    } catch {
      toast.error("Không thể ngắt liên kết (mạng/server).");
    }
  }, []);

  const loadFromDrive = useCallback(async () => {
    setIsSyncing(true);
    setSyncStatus("syncing");
    try {
      const r = await fetch(`${SYNC_URL}/api/drive/load`, {
        headers: { "x-user-id": USER_ID },
      });
      const out = await r.json().catch(() => ({}));
      if (r.status === 401 || out?.ok === false) {
        toast.error("Chưa liên kết Google Drive.");
        setSyncStatus("error");
        return;
      }
      if (!r.ok) {
        toast.error(`Lỗi tải từ Drive (${r.status})`);
        setSyncStatus("error");
        return;
      }
      const tag = r.headers.get("ETag") || null;
      const st = out.state || {};
      setMembers(st.members ?? []);
      setTxs(st.transactions ?? []);
      setVersion(out.version || 0);
      setEtag(tag);
      toast.success("Đã đồng bộ từ Google Drive!");
      setSyncStatus("success");
    } catch {
      toast.error("Không thể đồng bộ từ Drive.");
      setSyncStatus("error");
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncStatus("idle"), 2000);
    }
  }, []);

  const saveToDrive = useCallback(async () => {
    setIsSyncing(true);
    setSyncStatus("syncing");
    try {
      const r = await fetch(`${SYNC_URL}/api/drive/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": USER_ID,
          "x-api-key": SYNC_KEY || "changeme_dev",
          "If-Match": etag ?? "",
        },
        body: JSON.stringify({ state: { members, transactions: txs } }),
      });
      const out = await r.json().catch(() => ({}));
      if (r.status === 401 || out?.ok === false) {
        toast.error("Chưa liên kết Drive.");
        setSyncStatus("error");
        return;
      }
      if (r.status === 409) {
        const remote = await pullRemote();
        if (remote?.state) {
          setMembers(remote.state.members ?? []);
          setTxs(remote.state.transactions ?? []);
          setVersion(remote.version || 0);
          setEtag(remote.etag || null);
        }
        toast.warning("Dữ liệu trên Drive đã thay đổi. Đã tải lại, lưu lại lần nữa.");
        setSyncStatus("error");
        return;
      }
      if (!r.ok) {
        toast.error(`Lỗi lưu lên Drive (${r.status})`);
        setSyncStatus("error");
        return;
      }
      const tag = r.headers.get("ETag") || null;
      if (typeof out.version === "number") setVersion(out.version);
      if (tag) setEtag(tag);
      toast.success("Đã lưu lên Google Drive!");
      setSyncStatus("success");
    } catch {
      toast.error("Không thể lưu lên Drive.");
      setSyncStatus("error");
    } finally {
      setIsSyncing(false);
      setTimeout(() => setSyncStatus("idle"), 2000);
    }
  }, [etag, members, txs]);

  /* UI */
  const [tab, setTab] = useState("tx"); // tx | members | summary | charts | settings

  return (
    <div className={`min-h-screen pb-28 ${pageBg} ${pageText} font-[Inter] relative`}>
      {/* Animated gradient background */}
      <div className="fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute top-0 -left-4 w-96 h-96 bg-purple-500/10 rounded-full mix-blend-multiply filter blur-3xl opacity-70 animate-blob"></div>
        <div className="absolute top-0 -right-4 w-96 h-96 bg-indigo-500/10 rounded-full mix-blend-multiply filter blur-3xl opacity-70 animate-blob animation-delay-2000"></div>
        <div className="absolute -bottom-8 left-20 w-96 h-96 bg-cyan-500/10 rounded-full mix-blend-multiply filter blur-3xl opacity-70 animate-blob animation-delay-4000"></div>
      </div>

      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: {
            background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.95) 0%, rgba(15, 23, 42, 0.95) 100%)',
            color: '#f1f5f9',
            border: '1px solid rgba(99, 102, 241, 0.2)',
            borderRadius: '16px',
            backdropFilter: 'blur(12px)',
            boxShadow: '0 8px 32px 0 rgba(99, 102, 241, 0.15)',
          },
          success: {
            iconTheme: {
              primary: '#10b981',
              secondary: '#f1f5f9',
            },
          },
          error: {
            iconTheme: {
              primary: '#ef4444',
              secondary: '#f1f5f9',
            },
          },
        }}
      />
      {/* Header - Redesigned */}
      <div className="sticky top-0 z-30 bg-gradient-to-r from-slate-950/95 via-slate-900/95 to-slate-950/95 border-b border-indigo-500/20 backdrop-blur-2xl shadow-2xl">
        {/* Decorative line */}
        <div className="h-0.5 bg-gradient-to-r from-transparent via-indigo-500 to-transparent"></div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">
          <div className="flex items-center justify-between">
            {/* Logo & Title */}
            <div className="flex items-center gap-4 group">
              <div className="relative">
                {/* Animated ring */}
                <div className="absolute inset-0 rounded-3xl bg-gradient-to-tr from-indigo-500 via-purple-500 to-cyan-500 opacity-75 blur-lg group-hover:opacity-100 transition-opacity duration-500 animate-pulse"></div>
                <div className="relative h-14 w-14 rounded-3xl bg-gradient-to-tr from-indigo-600 via-purple-600 to-cyan-500 grid place-items-center shadow-2xl shadow-indigo-500/50 group-hover:scale-110 transition-transform duration-300">
                  <span className="text-2xl font-black text-white drop-shadow-lg">₫</span>
                </div>
              </div>

              <div className="leading-tight">
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-black tracking-tighter bg-gradient-to-r from-indigo-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent drop-shadow-lg">
                    MoneyTracker
                  </h1>
                  <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-gradient-to-r from-indigo-500/20 to-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                    PRO
                  </span>
                </div>
                <div className="text-xs text-slate-400 font-semibold tracking-wide flex items-center gap-2 mt-1">
                  <svg className="w-3 h-3 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zM8 7a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zM14 4a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z" />
                  </svg>
                  <span>Smart Group Expense Manager</span>
                </div>
              </div>
            </div>

            {/* Sync Status & Actions */}
            <div className="hidden lg:flex items-center gap-3">
              {/* Sync Status Badge */}
              <div
                className={`relative px-4 py-2 rounded-2xl flex items-center gap-2 backdrop-blur-xl transition-all duration-300 ${
                  syncStatus === "syncing"
                    ? "bg-blue-500/10 border border-blue-400/30 shadow-lg shadow-blue-500/20"
                    : syncStatus === "success"
                    ? "bg-emerald-500/10 border border-emerald-400/30 shadow-lg shadow-emerald-500/20"
                    : syncStatus === "error"
                    ? "bg-red-500/10 border border-red-400/30 shadow-lg shadow-red-500/20"
                    : SYNC_URL
                    ? "bg-emerald-500/10 border border-emerald-400/30"
                    : "bg-slate-800/50 border border-slate-700/50"
                }`}
                title={
                  syncStatus === "syncing"
                    ? "Đang đồng bộ..."
                    : syncStatus === "success"
                    ? "Đồng bộ thành công"
                    : syncStatus === "error"
                    ? "Lỗi đồng bộ"
                    : SYNC_URL
                    ? `Realtime ON · Poll ${SYNC_PULL_MS}ms`
                    : "Sync OFF"
                }
              >
                {syncStatus === "syncing" ? (
                  <svg className="animate-spin h-4 w-4 text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                ) : SYNC_URL ? (
                  <div className="relative">
                    <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></div>
                    <div className="absolute inset-0 w-2 h-2 rounded-full bg-emerald-400 animate-ping"></div>
                  </div>
                ) : (
                  <div className="w-2 h-2 rounded-full bg-slate-500"></div>
                )}
                <span className={`text-xs font-bold ${
                  syncStatus === "syncing" ? "text-blue-300" :
                  syncStatus === "success" ? "text-emerald-300" :
                  syncStatus === "error" ? "text-red-300" :
                  SYNC_URL ? "text-emerald-300" : "text-slate-400"
                }`}>
                  {syncStatus === "syncing" ? "Syncing..." : SYNC_URL ? "Live" : "Offline"}
                </span>
              </div>

              {/* Quick Actions */}
              <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={connectDrive}
              disabled={!SYNC_URL}
              title="Liên kết tài khoản Google để lưu lên Drive"
            >
              Kết nối Google Drive
            </Button>
            <Button
              variant="ghost"
              onClick={loadFromDrive}
              disabled={!SYNC_URL || isSyncing}
              title="Nạp dữ liệu đã lưu trên Drive"
            >
              {isSyncing ? "Đang tải..." : "Đồng bộ từ Drive"}
            </Button>
            <Button
              variant="ghost"
              onClick={saveToDrive}
              disabled={!SYNC_URL || isSyncing}
              title="Ghi dữ liệu hiện tại lên Drive"
            >
              {isSyncing ? "Đang lưu..." : "Lưu lên Drive"}
            </Button>
            <Button
              variant="ghost"
              onClick={resetDrive}
              disabled={!SYNC_URL}
              title="Ngắt liên kết nhưng KHÔNG xoá file trên Drive"
            >
              Ngắt liên kết
            </Button>
            <Button variant="subtle" onClick={downloadJSON} title="Tải file .json dự phòng">
              Sao lưu
            </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-28 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT: Thêm giao dịch & quản lý thành viên */}
        <LeftPane
          members={members}
          idToName={idToName}
          addMember={addMember}
          memberInput={memberInput}
          setMemberInput={setMemberInput}
          removeMember={removeMember}
          removeUnusedMembers={removeUnusedMembers}
          payerDraft={payerDraft}
          setPayerDraft={setPayerDraft}
          totalDraft={totalDraft}
          setTotalDraft={setTotalDraft}
          participantsDraft={participantsDraft}
          setParticipantsDraft={setParticipantsDraft}
          modeDraft={modeDraft}
          setModeDraft={setModeDraft}
          weightsDraft={weightsDraft}
          sharesDraft={sharesDraft}
          onWeightDraftChange={onWeightDraftChange}
          onShareDraftChange={onShareDraftChange}
          toggleParticipantDraft={toggleParticipantDraft}
          noteDraft={noteDraft}
          setNoteDraft={setNoteDraft}
          addTransaction={addTransaction}
          resetForm={resetForm}
        />

        {/* RIGHT: Tabs */}
        <RightPane
          tab={tab}
          setTab={setTab}
          txs={txs}
          setTxs={setTxs}
          setMembers={setMembers}
          normalizedTxs={normalizedTxs}
          idToName={idToName}
          removeTx={removeTx}
          togglePaid={togglePaid}
          computeShares={computeShares}
          balancesList={balancesList}
          totalCheck={totalCheck}
          transfers={transfers}
          spentByPayer={spentByPayer}
          // summary props
          summaryOnlySelected={summaryOnlySelected}
          setSummaryOnlySelected={setSummaryOnlySelected}
          summarySelectedIds={summarySelectedIds}
          setSummarySelectedIds={setSummarySelectedIds}
          summaryFrom={summaryFrom}
          setSummaryFrom={setSummaryFrom}
          summaryTo={summaryTo}
          setSummaryTo={setSummaryTo}
          summaryTxs={summaryTxs}
          summaryTransfers={summaryTransfers}
          summaryTotalCheck={summaryTotalCheck}
          // sync helpers
          connectDrive={connectDrive}
          loadFromDrive={loadFromDrive}
          saveToDrive={saveToDrive}
          resetDrive={resetDrive}
          downloadJSON={downloadJSON}
          importJSON={importJSON}
          exportCSV={exportCSV}
          USER_ID={USER_ID}
          SYNC_URL={SYNC_URL}
          SYNC_PULL_MS={SYNC_PULL_MS}
        />
      </div>
      {/* Bottom Mobile Nav */}
      <BottomNav tab={tab} setTab={setTab} />

      <footer className="py-10 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} MoneyTracker · User: {USER_ID}
      </footer>
    </div>
  );
}

/* ===== Split UI into small components (giảm chiều dài file) ===== */
function LeftPane(props) {
  const {
    members,
    idToName,
    addMember,
    memberInput,
    setMemberInput,
    removeMember,
    removeUnusedMembers,
    payerDraft,
    setPayerDraft,
    totalDraft,
    setTotalDraft,
    participantsDraft,
    setParticipantsDraft,
    modeDraft,
    setModeDraft,
    weightsDraft,
    sharesDraft,
    onWeightDraftChange,
    onShareDraftChange,
    toggleParticipantDraft,
    noteDraft,
    setNoteDraft,
    addTransaction,
    resetForm,
  } = props;

  return (
    <div className="lg:col-span-1 space-y-6">
      <Card title="Thêm giao dịch">
        <div className="grid grid-cols-1 gap-3">
          <Select
            label="Payer"
            value={payerDraft}
            onChange={(e) => setPayerDraft(Number(e.target.value))}
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Input
            label="Total (VND)"
            value={totalDraft}
            onChange={(e) => setTotalDraft(e.target.value)}
            placeholder="vd 120000"
          />
          <Select
            label="Mode"
            value={modeDraft}
            onChange={(e) => setModeDraft(e.target.value)}
          >
            <option value="equal">Equal</option>
            <option value="weights">Weights</option>
            <option value="explicit">Explicit</option>
          </Select>

          <div>
            <div className="text-xs text-slate-400 mb-2">Participants</div>
            <div className="flex flex-wrap gap-2">
              {members.map((m) => {
                const active = participantsDraft.includes(m.id);
                return (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => toggleParticipantDraft(m.id)}
                    className={`px-3 py-1.5 rounded-full border text-xs ${
                      active
                        ? "border-emerald-400 bg-emerald-500/15"
                        : "border-slate-700 bg-slate-900/70 hover:bg-slate-800/70"
                    }`}
                  >
                    {m.name}
                  </button>
                );
              })}
            </div>
          </div>

          {modeDraft === "weights" && participantsDraft.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 mb-2">Weights</div>
              <div className="grid grid-cols-2 gap-2">
                {participantsDraft.map((pid) => (
                  <div key={pid} className="flex items-center gap-2">
                    <div className="w-28 text-sm text-slate-300">
                      {idToName.get(pid)}
                    </div>
                    <input
                      className="flex-1 bg-slate-900/70 border border-slate-700 rounded-xl px-3 py-2 text-sm"
                      placeholder="vd 1"
                      inputMode="decimal"
                      value={weightsDraft[pid] ?? ""}
                      onChange={(e) => onWeightDraftChange(pid, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {modeDraft === "explicit" && participantsDraft.length > 0 && (
            <div>
              <div className="text-xs text-slate-400 mb-2">Shares (VND)</div>
              <div className="grid grid-cols-2 gap-2">
                {participantsDraft.map((pid) => (
                  <div key={pid} className="flex items-center gap-2">
                    <div className="w-28 text-sm text-slate-300">
                      {idToName.get(pid)}
                    </div>
                    <input
                      className="flex-1 bg-slate-900/70 border border-slate-700 rounded-xl px-3 py-2 text-sm"
                      placeholder="vd 30000"
                      inputMode="numeric"
                      value={sharesDraft[pid] ?? ""}
                      onChange={(e) => onShareDraftChange(pid, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <Input
            label="Ghi chú"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="VD: BBQ tối T6"
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              onClick={resetForm}
              title="Xóa toàn bộ form và bắt đầu lại"
              className="text-xs"
            >
              Reset Form
            </Button>
            <Button onClick={addTransaction} title="Thêm giao dịch mới">
              Thêm giao dịch
            </Button>
          </div>
        </div>
      </Card>

      <Card
        title="Thành viên"
        action={
          <div className="flex items-end gap-2">
            <Input
              label="Thêm"
              value={memberInput}
              onChange={(e) => setMemberInput(e.target.value)}
              placeholder="Tên"
            />
            <Button onClick={addMember} title="Thêm thành viên">
              Thêm
            </Button>
          </div>
        }
      >
        <div className="space-y-2">
          {members.map((m) => (
            <div
              key={m.id}
              className="rounded-xl px-3 py-2 border border-slate-700 bg-slate-900/60 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className="h-6 w-6 rounded-lg" style={{ background: m.color }} />
                <div className="font-medium tracking-tight">{m.name}</div>
              </div>
              <Button variant="ghost" onClick={() => removeMember(m.id)} title="Xóa thành viên">
                Xóa
              </Button>
            </div>
          ))}
          {members.length === 0 && (
            <div className="text-sm text-slate-400 text-center py-4">
              Chưa có thành viên
            </div>
          )}
          <div className="pt-2 flex gap-2">
            <Button variant="subtle" onClick={removeUnusedMembers} title="Xóa thành viên không nằm trong giao dịch">
              Xóa thành viên không thuộc giao dịch
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function RightPane(props) {
  const {
    tab,
    setTab,
    txs,
    setTxs,
    setMembers,
    normalizedTxs,
    idToName,
    removeTx,
    togglePaid,
    computeShares,
    balancesList,
    totalCheck,
    spentByPayer,
    // summary props
    summaryOnlySelected,
    setSummaryOnlySelected,
    summarySelectedIds,
    setSummarySelectedIds,
    summaryFrom,
    setSummaryFrom,
    summaryTo,
    setSummaryTo,
    summaryTxs,
    summaryTransfers,
    summaryTotalCheck,
    // sync helpers
    connectDrive,
    loadFromDrive,
    saveToDrive,
    resetDrive,
    downloadJSON,
    importJSON,
    exportCSV,
    USER_ID,
    SYNC_URL,
    SYNC_PULL_MS,
  } = props;

  const pad2 = (x) => String(x).padStart(2, "0");
  const quickMonth = () => {
    const d = new Date();
    const y = d.getFullYear(), m = d.getMonth();
    setSummaryFrom(`${y}-${pad2(m+1)}-01`);
    setSummaryTo(`${y}-${pad2(m+1)}-${pad2(new Date(y, m+1, 0).getDate())}`);
  };
  const quickWeek = () => {
    const d = new Date();
    const w = d.getDay() || 7; // Mon=1..Sun=7
    const start = new Date(d); start.setDate(d.getDate() - (w-1));
    const end = new Date(start); end.setDate(start.getDate() + 6);
    setSummaryFrom(`${start.getFullYear()}-${pad2(start.getMonth()+1)}-${pad2(start.getDate())}`);
    setSummaryTo(`${end.getFullYear()}-${pad2(end.getMonth()+1)}-${pad2(end.getDate())}`);
  };

  return (
    <div className="lg:col-span-2 space-y-6">
      <Card
        title="Điều hướng"
        action={
          <div className="hidden sm:flex gap-2">
            <Button
              variant={tab === "tx" ? "primary" : "ghost"}
              onClick={() => setTab("tx")}
            >
              Lịch sử
            </Button>
            <Button
              variant={tab === "members" ? "primary" : "ghost"}
              onClick={() => setTab("members")}
            >
              Thành viên
            </Button>
            <Button
              variant={tab === "summary" ? "primary" : "ghost"}
              onClick={() => setTab("summary")}
            >
              Tổng kết
            </Button>
            <Button
              variant={tab === "charts" ? "primary" : "ghost"}
              onClick={() => setTab("charts")}
            >
              Charts
            </Button>
            <Button
              variant={tab === "settings" ? "primary" : "ghost"}
              onClick={() => setTab("settings")}
            >
              Cài đặt
            </Button>
          </div>
        }
      >
        <div className="text-xs text-slate-400">
          Tip: Trên mobile dùng thanh điều hướng dưới cùng.
        </div>
      </Card>

      {tab === "tx" && (
        <Card
          title={`Giao dịch (${txs.length})`}
          action={
            <div className="flex gap-2">
              <Button variant="ghost" onClick={exportCSV}>
                Export CSV
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const confirmed = await confirmAction("Xóa tất cả giao dịch?");
                  if (confirmed) setTxs([]);
                }}
              >
                Xóa hết
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            {txs.length === 0 && (
              <div className="text-sm text-slate-400 text-center py-6">
                Chưa có giao dịch.
              </div>
            )}
            {normalizedTxs.map((t) => {
              const parts = (t.participants || [])
                .map((id) => idToName.get(id) ?? id)
                .join(", ");
              const payerName = idToName.get(t.payer) ?? t.payer;
              const shares = computeShares(t);
              const selected = summarySelectedIds.includes(t.id);
              return (
                <div
                  key={t.id}
                  className="group relative rounded-2xl p-4 border border-slate-700/50 bg-gradient-to-br from-slate-900/50 to-slate-800/30 backdrop-blur-sm transition-all duration-300 hover:border-indigo-500/40 hover:shadow-lg hover:shadow-indigo-500/5 hover:scale-[1.02]"
                >
                  {/* Gradient overlay on hover */}
                  <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-indigo-500/0 to-cyan-500/0 group-hover:from-indigo-500/5 group-hover:to-cyan-500/5 transition-all duration-300"></div>

                  <div className="relative flex items-center justify-between gap-3">
                    <div className="font-semibold tracking-tight text-slate-100 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-gradient-to-r from-indigo-400 to-cyan-400 animate-pulse"></span>
                      {t.note || "(Không ghi chú)"}
                    </div>
                    <div className="text-base font-bold bg-gradient-to-r from-emerald-400 to-emerald-300 bg-clip-text text-transparent">
                      {toVND(t.total)}
                    </div>
                  </div>

                  <div className="relative mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                    <label className="inline-flex items-center gap-2 cursor-pointer hover:text-slate-300 transition-colors">
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-slate-900 cursor-pointer transition-all"
                        checked={selected}
                        onChange={(e) => {
                          setSummarySelectedIds((prev) =>
                            e.target.checked
                              ? [...prev, t.id]
                              : prev.filter((x) => x !== t.id)
                          );
                        }}
                      />
                      <span className="font-medium">Đưa vào tổng kết</span>
                    </label>
                    <span className="opacity-50">•</span>
                    <span className="flex items-center gap-1.5">
                      <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {new Date(t.ts).toLocaleString("vi-VN", { dateStyle: 'short', timeStyle: 'short' })}
                    </span>
                    <span className="opacity-50">•</span>
                    <span className="capitalize font-medium text-indigo-400">{t.mode}</span>
                    <span className="opacity-50">•</span>
                    <span>Payer: <span className="text-cyan-400 font-semibold">{payerName}</span></span>
                  </div>

                  <div className="mt-1 text-xs text-slate-400">
                    Participants: {parts}
                  </div>

                  <div className="relative mt-4">
                    <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="font-medium">Đánh dấu đã trả</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(t.participants || [])
                        .filter((pid) => pid !== t.payer)
                        .map((pid) => {
                          const checked = (t.paid || []).includes(pid);
                          return (
                            <label
                              key={pid}
                              className={`group/badge relative inline-flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium cursor-pointer transition-all duration-200 ${
                                checked
                                  ? "bg-gradient-to-r from-emerald-500/20 to-emerald-600/10 border-emerald-400/60 text-emerald-300 shadow-lg shadow-emerald-500/20"
                                  : "border-slate-700/70 bg-slate-800/40 text-slate-300 hover:border-slate-600 hover:bg-slate-800/60"
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="w-4 h-4 rounded border-slate-600 bg-slate-900 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-900 cursor-pointer transition-all"
                                checked={checked}
                                onChange={() => togglePaid(t.id, pid)}
                              />
                              <span>{idToName.get(pid)}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-md ${checked ? 'bg-emerald-400/20' : 'bg-slate-700/50'}`}>
                                {toVND(shares[pid] || 0)}
                              </span>
                            </label>
                          );
                        })}
                    </div>
                  </div>

                  <details className="relative mt-4 group/details">
                    <summary className="cursor-pointer flex items-center gap-2 text-sm font-medium text-indigo-400 hover:text-indigo-300 transition-colors">
                      <svg className="w-4 h-4 transition-transform group-open/details:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      Chi tiết phân chia
                    </summary>
                    <div className="mt-3 bg-gradient-to-br from-slate-950/80 to-slate-900/60 p-4 rounded-xl border border-slate-700/50 backdrop-blur-sm">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {Object.entries(shares).map(([uid, a]) => (
                          <div
                            key={uid}
                            className="flex items-center justify-between py-2 px-3 rounded-lg bg-slate-800/40 border border-slate-700/30"
                          >
                            <span className="font-medium text-slate-200">{idToName.get(Number(uid)) ?? uid}</span>
                            <span className="font-bold text-emerald-400">{toVND(a)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>

                  <div className="relative mt-4 flex justify-end">
                    <button
                      onClick={() => removeTx(t.id)}
                      className="group/del px-4 py-2 rounded-xl bg-gradient-to-r from-rose-600/10 to-red-600/10 border border-rose-500/30 text-rose-400 hover:from-rose-600/20 hover:to-red-600/20 hover:border-rose-400 hover:text-rose-300 transition-all duration-200 hover:shadow-lg hover:shadow-rose-500/20 text-sm font-medium flex items-center gap-2"
                      title="Xóa giao dịch này"
                    >
                      <svg className="w-4 h-4 group-hover/del:animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Xóa
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {tab === "members" && (
        <Card
          title="Số dư theo thành viên (chỉ tính khoản chưa trả)"
          action={
            <div
              className={`text-sm ${
                totalCheck === 0 ? "text-emerald-300" : "text-rose-300"
              }`}
              title="Tổng kiểm tra phải = 0"
            >
              Tổng kiểm tra: {toVND(totalCheck)}
            </div>
          }
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {balancesList.map((b) => (
              <div
                key={b.id}
                className="rounded-xl px-3 py-2 border border-slate-700 bg-slate-900/60"
              >
                <div className="flex items-center justify-between">
                  <div className="font-medium">{b.name}</div>
                  <div
                    className={`font-semibold ${
                      b.amount > 0
                        ? "text-emerald-300"
                        : b.amount < 0
                        ? "text-rose-300"
                        : "text-slate-300"
                    }`}
                  >
                    {toVND(b.amount)}
                  </div>
                </div>
              </div>
            ))}
            {balancesList.length === 0 && (
              <div className="text-sm text-slate-400">Chưa có dữ liệu.</div>
            )}
          </div>
        </Card>
      )}

      {tab === "summary" && (
        <Card
          title="Tổng kết linh hoạt (lọc & nhiều giao dịch)"
          action={
            <div className="flex items-end gap-2">
              <label className="text-xs text-slate-300">
                From
                <input
                  type="date"
                  value={summaryFrom}
                  onChange={(e) => setSummaryFrom(e.target.value)}
                  className="ml-2 px-2 py-1 bg-slate-900/70 border border-slate-700 rounded-lg text-slate-100"
                />
              </label>
              <label className="text-xs text-slate-300">
                To
                <input
                  type="date"
                  value={summaryTo}
                  onChange={(e) => setSummaryTo(e.target.value)}
                  className="ml-2 px-2 py-1 bg-slate-900/70 border border-slate-700 rounded-lg text-slate-100"
                />
              </label>
              <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  className="accent-indigo-500"
                  checked={summaryOnlySelected}
                  onChange={(e) => setSummaryOnlySelected(e.target.checked)}
                />
                Chỉ tính giao dịch đã chọn
              </label>
              <Button variant="ghost" onClick={quickWeek} title="Tuần này">
                Tuần này
              </Button>
              <Button variant="ghost" onClick={quickMonth} title="Tháng này">
                Tháng này
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setSummaryFrom("");
                  setSummaryTo("");
                }}
                title="Toàn bộ"
              >
                Toàn bộ
              </Button>
            </div>
          }
        >
          <div className="text-xs text-slate-400 mb-3">
            Đang tính trên <b>{summaryTxs.length}</b> giao dịch. Tổng kiểm tra:&nbsp;
            <span className={summaryTotalCheck === 0 ? "text-emerald-300" : "text-rose-300"}>
              {toVND(summaryTotalCheck)}
            </span>
          </div>

          {summaryTransfers.length === 0 ? (
            <div className="text-sm text-slate-400">Không cần chuyển khoản.</div>
          ) : (
            <ul className="space-y-2">
              {summaryTransfers.map((t, i) => (
                <li
                  key={i}
                  className="flex justify-between rounded-lg px-3 py-2 bg-slate-950/40 border border-slate-700"
                >
                  <span>
                    {t.from} → {t.to}
                  </span>
                  <span className="font-semibold">{toVND(t.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 text-xs text-slate-400">
            * Luôn bỏ qua các khoản đã “đánh dấu đã trả” theo thuật toán hiện tại.<br/>
            * Có thể kết hợp vừa chọn checkbox ở tab “Lịch sử”, vừa lọc theo khoảng ngày.
          </div>
        </Card>
      )}

      {tab === "charts" && (
        <Card title="Charts (CSS-only)">
          <div className="space-y-6">
            <div>
              <div className="text-sm mb-2">Tổng chi theo người trả</div>
              <div className="space-y-2">
                {spentByPayer.map((r) => {
                  const max = Math.max(1, ...spentByPayer.map((x) => x.total));
                  const w = Math.round((r.total / max) * 100);
                  return (
                    <div key={r.id}>
                      <div className="flex justify-between text-xs text-slate-400 mb-1">
                        <span>{r.name}</span>
                        <span>{toVND(r.total)}</span>
                      </div>
                      <div className="h-2 rounded bg-slate-800 overflow-hidden">
                        <div className="h-2 bg-indigo-600" style={{ width: `${w}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-6">
              <BarList
                title="Phải thu (dương)"
                data={balancesList.filter((b) => b.amount > 0)}
                color="bg-emerald-600"
              />
              <BarList
                title="Phải trả (âm)"
                data={balancesList
                  .filter((b) => b.amount < 0)
                  .map((x) => ({ ...x, amount: -x.amount }))}
                color="bg-rose-600"
              />
            </div>
          </div>
        </Card>
      )}

      {tab === "settings" && (
        <Card title="Cài đặt & Dữ liệu">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Button
              variant="ghost"
              onClick={connectDrive}
              disabled={!SYNC_URL}
              title="Liên kết Google Drive"
            >
              Kết nối Google Drive
            </Button>
            <Button
              variant="ghost"
              onClick={loadFromDrive}
              disabled={!SYNC_URL}
              title="Nạp dữ liệu từ Drive"
            >
              Đồng bộ từ Drive
            </Button>
            <Button
              variant="ghost"
              onClick={saveToDrive}
              disabled={!SYNC_URL}
              title="Ghi dữ liệu lên Drive"
            >
              Lưu lên Drive
            </Button>
            <Button
              variant="ghost"
              onClick={resetDrive}
              disabled={!SYNC_URL}
              title="Ngắt liên kết Drive"
            >
              Ngắt liên kết Drive
            </Button>
            <Button variant="subtle" onClick={downloadJSON} title="Tải file JSON">
              Sao lưu JSON
            </Button>
            <label className="inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm cursor-pointer border bg-slate-900/70 border-slate-700">
              Import JSON
              <input
                type="file"
                accept="application/json"
                onChange={importJSON}
                className="hidden"
              />
            </label>
            <Button variant="ghost" onClick={exportCSV} title="Xuất CSV">
              Export CSV
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const confirmed = await confirmAction("Xóa toàn bộ dữ liệu local?");
                if (confirmed) {
                  setTxs([]);
                  setMembers([]);
                  toast.success("Đã xóa toàn bộ dữ liệu local");
                }
              }}
              title="Chỉ xoá local – không ảnh hưởng dữ liệu Drive"
            >
              Reset Local
            </Button>
          </div>
          <div className="mt-4 text-xs text-slate-400">
            User: {USER_ID}
            {SYNC_URL ? ` · Realtime ON · Pull ${SYNC_PULL_MS}ms` : ` · Sync OFF`}
          </div>
        </Card>
      )}
    </div>
  );
}

function BarList({ title, data, color }) {
  return (
    <div>
      <div className="text-sm mb-2">{title}</div>
      {data.length === 0 && <div className="text-xs text-slate-400">—</div>}
      <div className="space-y-2">
        {data.map((b) => {
          const max = Math.max(1, ...data.map((x) => x.amount));
          const w = Math.round((Math.abs(b.amount) / max) * 100);
          return (
            <div key={b.id}>
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>{b.name}</span>
                <span>{toVND(b.amount)}</span>
              </div>
              <div className="h-2 rounded bg-slate-800 overflow-hidden">
                <div className={`h-2 ${color}`} style={{ width: `${w}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BottomNav({ tab, setTab }) {
  const items = [
    { key: "tx",       label: "Lịch sử",    icon: <i className="fa-solid fa-receipt" aria-hidden="true"></i> },
    { key: "members",  label: "Thành viên", icon: <i className="fa-solid fa-users" aria-hidden="true"></i> },
    { key: "summary",  label: "Tổng kết",   icon: <i className="fa-solid fa-circle-check" aria-hidden="true"></i> },
    { key: "charts",   label: "Charts",     icon: <i className="fa-solid fa-chart-bar" aria-hidden="true"></i> },
    { key: "settings", label: "Cài đặt",    icon: <i className="fa-solid fa-gear" aria-hidden="true"></i> },
  ];
  const idx = Math.max(0, items.findIndex((i) => i.key === tab));
  const widthPct = 100 / items.length;
  const leftPct = idx * widthPct;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-slate-800 bg-slate-950/95 backdrop-blur sm:hidden">
      <div className="relative max-w-7xl mx-auto">
        <div
          className="absolute bottom-0 h-0.5 bg-indigo-400 transition-all duration-300 ease-out"
          style={{ width: `${widthPct}%`, left: `${leftPct}%` }}
        />
        <div className="grid" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
          {items.map((it) => {
            const active = tab === it.key;
            return (
              <button
                key={it.key}
                onClick={() => setTab(it.key)}
                className={`py-2.5 text-xs flex flex-col items-center gap-1 transition-all duration-200 ${
                  active ? "text-indigo-300 scale-105" : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {/* icon FA */}
                <span className="text-base leading-none">{it.icon}</span>
                <span>{it.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

// Wrap App with ErrorBoundary
function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

export { ErrorBoundary };
export default AppWithErrorBoundary;

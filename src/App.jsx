// src/App.jsx
import React, { useEffect, useMemo, useState } from "react";

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
    "inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed";
  const map = {
    primary:
      "bg-indigo-600 hover:bg-indigo-700 text-white focus:ring-indigo-300 focus:ring-offset-slate-900",
    ghost:
      "bg-transparent border border-slate-700 hover:bg-slate-800/60 text-slate-100 focus:ring-cyan-300 focus:ring-offset-slate-900",
    danger:
      "bg-rose-600 hover:bg-rose-700 text-white focus:ring-rose-300 focus:ring-offset-slate-900",
    subtle:
      "bg-slate-800 text-slate-100 border border-slate-700 hover:bg-slate-700/60 focus:ring-cyan-300 focus:ring-offset-slate-900",
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
      <span className="text-xs text-slate-300">{label}</span>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm rounded-xl bg-slate-900/70 border border-slate-700 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-300"
      />
    </label>
  );
}
function Select({ label, value, onChange, children }) {
  return (
    <label className="space-y-1.5 block">
      <span className="text-xs text-slate-300">{label}</span>
      <select
        value={value}
        onChange={onChange}
        className="w-full px-3 py-2 text-sm rounded-xl bg-slate-900/70 border border-slate-700 text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-300"
      >
        {children}
      </select>
    </label>
  );
}
function Card({ title, action, children }) {
  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/60 shadow-lg shadow-black/20">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/60">
        <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/* ===== App ===== */
export default function App() {
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

  /* === Summary (linh hoạt) state === */
  const [summaryOnlySelected, setSummaryOnlySelected] = useState(false);
  const [summarySelectedIds, setSummarySelectedIds] = useState([]); // ids của tx được chọn
  const [summaryFrom, setSummaryFrom] = useState(""); // yyyy-mm-dd
  const [summaryTo, setSummaryTo] = useState("");     // yyyy-mm-dd

  /* persist local */
  useEffect(() => saveMembers(members), [members]);
  useEffect(() => saveTxs(txs), [txs]);

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

  /* auto-save (debounce) */
  const stateObj = useMemo(() => ({ members, transactions: txs }), [members, txs]);
  useEffect(() => {
    const to = setTimeout(async () => {
      try {
        const pushed = await pushRemote(stateObj, etag);
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

  /* realtime (SSE) */
  useEffect(() => {
    if (!SYNC_URL) return;
    const ev = new EventSource(
      `${SYNC_URL}/api/stream?user=${encodeURIComponent(USER_ID)}`
    );
    ev.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg?.type === "update") {
          setMembers(Array.isArray(msg.state?.members) ? msg.state.members : []);
          setTxs(
            Array.isArray(msg.state?.transactions)
              ? msg.state.transactions
              : []
          );
          setVersion(typeof msg.version === "number" ? msg.version : 0);
          setEtag(msg.etag || null);
          console.log("🔄 Realtime update (SSE)");
        }
      } catch {}
    };
    ev.onerror = () => {}; // để polling xử lý dự phòng
    return () => ev.close();
  }, []);

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

  /* actions: members */
  const addMember = () => {
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
  };
  const removeMember = (id) => {
    if (!confirm("Xóa thành viên này?")) return;
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
  };
  const removeUnusedMembers = () => {
    const used = new Set();
    normalizedTxs.forEach((t) => {
      used.add(t.payer);
      (t.participants || []).forEach((id) => used.add(id));
    });
    const keep = members.filter((m) => used.has(m.id));
    if (keep.length === members.length) return alert("Không có thành viên thừa.");
    if (confirm(`Xóa ${members.length - keep.length} thành viên không thuộc giao dịch?`))
      setMembers(keep);
  };

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
  const toggleParticipantDraft = (id) =>
    setParticipantsDraft((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  const onWeightDraftChange = (id, v) =>
    setWeightsDraft((w) => ({ ...w, [id]: Number(v) }));
  const onShareDraftChange = (id, v) =>
    setSharesDraft((s) => ({ ...s, [id]: toInt(v) }));
  const addTransaction = () => {
    const total = toInt(totalDraft);
    const parts = participantsDraft.filter((pid) =>
      members.some((m) => m.id === pid)
    );
    if (!payerDraft || !members.some((m) => m.id === payerDraft))
      return alert("Payer không hợp lệ.");
    if (total <= 0) return alert("Total phải > 0.");
    if (parts.length === 0) return alert("Chọn ít nhất 1 participant.");

    const tx = {
      id: `T${Date.now()}`,
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
    if (sum !== total) return alert("Shares <> total. Kiểm tra lại.");

    setTxs((arr) => [tx, ...arr]);
    setTotalDraft("");
    setModeDraft("equal");
    setWeightsDraft({});
    setSharesDraft({});
    setNoteDraft("");
    setParticipantsDraft(members.map((m) => m.id));
  };
  const removeTx = (id) => {
    if (confirm("Xóa giao dịch này?"))
      setTxs((arr) => arr.filter((t) => t.id !== id));
  };
  const togglePaid = (txId, memberId) => {
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
  };

  /* export / import */
  const downloadJSON = () => {
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
  };
  const importJSON = (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (Array.isArray(data.members)) setMembers(data.members);
        if (Array.isArray(data.transactions)) setTxs(data.transactions);
        alert("Import thành công");
      } catch {
        alert("File không hợp lệ");
      }
    };
    r.readAsText(f);
  };
  const exportCSV = () => {
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
  };

  /* Drive OAuth & Sync (manual) */
  const connectDrive = async () => {
    if (!SYNC_URL) return alert("Chưa cấu hình VITE_SYNC_URL");
    try {
      const r = await fetch(
        `${SYNC_URL}/api/auth/url?user=${encodeURIComponent(USER_ID)}`,
        { headers: { "x-user-id": USER_ID } }
      );
      const { url } = await r.json();
      if (url)
        window.open(url, "_blank", "width=520,height=640");
      else alert("Không lấy được URL liên kết");
    } catch {
      alert("Không thể kết nối Google Drive");
    }
  };
  const resetDrive = async () => {
    if (!SYNC_URL) return alert("Chưa cấu hình VITE_SYNC_URL");
    if (!confirm("Ngắt liên kết Google Drive cho tài khoản này?")) return;
    try {
      const r = await fetch(`${SYNC_URL}/api/auth/reset`, {
        method: "POST",
        headers: { "x-user-id": USER_ID },
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || out?.ok === false)
        return alert("Không thể ngắt liên kết: " + (out?.error || `(${r.status})`));
      alert("Đã ngắt liên kết. Bấm 'Kết nối Google Drive' để cấp lại quyền.");
    } catch {
      alert("Không thể ngắt liên kết (mạng/server).");
    }
  };
  const loadFromDrive = async () => {
    try {
      const r = await fetch(`${SYNC_URL}/api/drive/load`, {
        headers: { "x-user-id": USER_ID },
      });
      const out = await r.json().catch(() => ({}));
      if (r.status === 401 || out?.ok === false)
        return alert("Chưa liên kết Google Drive.");
      if (!r.ok) return alert(`Lỗi tải từ Drive (${r.status})`);
      const tag = r.headers.get("ETag") || null;
      const st = out.state || {};
      setMembers(st.members ?? []);
      setTxs(st.transactions ?? []);
      setVersion(out.version || 0);
      setEtag(tag);
      alert("Đã đồng bộ từ Google Drive.");
    } catch {
      alert("Không thể đồng bộ từ Drive.");
    }
  };
  const saveToDrive = async () => {
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
      if (r.status === 401 || out?.ok === false)
        return alert("Chưa liên kết Drive.");
      if (r.status === 409) {
        const remote = await pullRemote();
        if (remote?.state) {
          setMembers(remote.state.members ?? []);
          setTxs(remote.state.transactions ?? []);
          setVersion(remote.version || 0);
          setEtag(remote.etag || null);
        }
        return alert(
          "Dữ liệu trên Drive đã thay đổi. Đã tải lại, lưu lại lần nữa."
        );
      }
      if (!r.ok) return alert(`Lỗi lưu lên Drive (${r.status})`);
      const tag = r.headers.get("ETag") || null;
      if (typeof out.version === "number") setVersion(out.version);
      if (tag) setEtag(tag);
      alert("Đã lưu lên Google Drive.");
    } catch {
      alert("Không thể lưu lên Drive.");
    }
  };

  /* UI */
  const [tab, setTab] = useState("tx"); // tx | members | summary | charts | settings

  return (
    <div className={`min-h-screen pb-28 ${pageBg} ${pageText} font-[Inter]`}>
      {/* Header */}
      <div className="sticky top-0 z-20 bg-slate-950/70 border-b border-slate-800 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-2xl bg-gradient-to-tr from-indigo-600 to-cyan-400 grid place-items-center font-extrabold">
              ₫
            </div>
            <div className="leading-tight">
              <div className="font-semibold tracking-tight">MoneyTracker</div>
              <div className="text-xs text-slate-400">
                Chia tiền nhóm · VND integer
              </div>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-2">
            <span
              className={`px-2 py-1 rounded-lg text-xs border ${
                SYNC_URL
                  ? "border-emerald-400 text-emerald-300"
                  : "border-slate-700 text-slate-400"
              }`}
              title={
                SYNC_URL
                  ? `Realtime ON (SSE) · Poll ${SYNC_PULL_MS}ms`
                  : "Sync OFF"
              }
            >
              {SYNC_URL ? "Realtime ON" : "Sync OFF"}
            </span>
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
              disabled={!SYNC_URL}
              title="Nạp dữ liệu đã lưu trên Drive"
            >
              Đồng bộ từ Drive
            </Button>
            <Button
              variant="ghost"
              onClick={saveToDrive}
              disabled={!SYNC_URL}
              title="Ghi dữ liệu hiện tại lên Drive"
            >
              Lưu lên Drive
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
            <label className="inline-flex items-center rounded-xl px-3 py-2 text-sm cursor-pointer border bg-slate-900/70 border-slate-700">
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
        />

        {/* RIGHT: Tabs */}
        <RightPane
          tab={tab}
          setTab={setTab}
          txs={txs}
          setTxs={setTxs}
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
          <div className="flex items-center justify-end">
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
    normalizedTxs,
    idToName,
    removeTx,
    togglePaid,
    computeShares,
    balancesList,
    totalCheck,
    transfers,
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
                onClick={() => {
                  if (confirm("Xóa tất cả giao dịch?")) setTxs([]);
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
                  className="rounded-2xl p-3 border border-slate-700 bg-slate-900/60"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium tracking-tight">
                      {t.note || "(Không ghi chú)"}
                    </div>
                    <div className="text-sm font-semibold">{toVND(t.total)}</div>
                  </div>

                  <div className="mt-2 flex items-center gap-3 text-xs text-slate-400">
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-indigo-500"
                        checked={selected}
                        onChange={(e) => {
                          setSummarySelectedIds((prev) =>
                            e.target.checked
                              ? [...prev, t.id]
                              : prev.filter((x) => x !== t.id)
                          );
                        }}
                      />
                      <span>Đưa vào “Tổng kết”</span>
                    </label>
                    <span className="opacity-70">|</span>
                    <span>
                      {new Date(t.ts).toLocaleString("vi-VN")} · Mode: {t.mode} ·
                      Payer: <span className="text-slate-200">{payerName}</span>
                    </span>
                  </div>

                  <div className="mt-1 text-xs text-slate-400">
                    Participants: {parts}
                  </div>

                  <div className="mt-3">
                    <div className="text-xs text-slate-400 mb-1">
                      Đánh dấu đã trả
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(t.participants || [])
                        .filter((pid) => pid !== t.payer)
                        .map((pid) => {
                          const checked = (t.paid || []).includes(pid);
                          return (
                            <label
                              key={pid}
                              className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full border text-xs ${
                                checked
                                  ? "bg-emerald-500/10 border-emerald-400 text-emerald-300"
                                  : "border-slate-700 bg-slate-900/70 text-slate-300"
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="accent-emerald-500"
                                checked={checked}
                                onChange={() => togglePaid(t.id, pid)}
                              />
                              {idToName.get(pid)}{" "}
                              <span className="opacity-70">
                                ({toVND(shares[pid] || 0)})
                              </span>
                            </label>
                          );
                        })}
                    </div>
                  </div>

                  <details className="mt-3">
                    <summary className="cursor-pointer text-emerald-300 hover:underline text-sm">
                      Xem shares
                    </summary>
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {Object.entries(shares).map(([uid, a]) => (
                        <div
                          key={uid}
                          className="flex items-center justify-between rounded-lg px-3 py-2 bg-slate-950/40 border border-slate-700"
                        >
                          <span className="text-slate-300">
                            {idToName.get(Number(uid)) ?? uid}
                          </span>
                          <span className="font-semibold">{toVND(a)}</span>
                        </div>
                      ))}
                    </div>
                  </details>

                  <div className="mt-2 flex items-center justify-end">
                    <Button variant="ghost" onClick={() => removeTx(t.id)}>
                      Xóa
                    </Button>
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
              onClick={() => {
                if (confirm("Xóa toàn bộ dữ liệu local?")) {
                  setTxs([]);
                  setMembers([]);
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
            {/* icon FA7 */}
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

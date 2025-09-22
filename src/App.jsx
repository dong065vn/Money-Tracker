// src/App.jsx
import React, { useEffect, useMemo, useState } from "react";

/* =========================
   ENV + SYNC (BACKEND)
   ========================= */
const SYNC_URL = import.meta.env.VITE_SYNC_URL;
const SYNC_KEY = import.meta.env.VITE_SYNC_KEY;
const SYNC_PULL_MS = Number(import.meta.env.VITE_SYNC_PULL_MS || 5000);

/* =========================
   FRONTEND chỉ gọi API backend
   KHÔNG tự tạo OAuth URL ở đây
   ========================= */

/* =========================
   USER-ID
   ========================= */
const USER_ID = (() => {
  const KEY = "mt_userId";
  let v = localStorage.getItem(KEY);
  if (!v) {
    const guid = crypto?.randomUUID?.() ?? `user-${Date.now()}`;
    v = guid;
    localStorage.setItem(KEY, v);
  }
  return v;
})();

/* =========================
   Helpers tiền tệ (VND integer)
   ========================= */
const toInt = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Math.trunc(v);
  const s = String(v).replace(/[^\d-]/g, "");
  const n = parseInt(s || "0", 10);
  return isNaN(n) ? 0 : Math.trunc(n);
};
const toVND = (n) =>
  (n ?? 0).toLocaleString("vi-VN", { maximumFractionDigits: 0 }) + " ₫";

/* =========================
   Core: chia tiền & tính toán (theo form yêu cầu)
   ========================= */
// Chia đều với cân dư
function splitEqual(total, participants) {
  const n = participants.length;
  if (!n) return {};
  const base = Math.floor(total / n);
  let rem = total - base * n;
  const shares = {};
  for (let i = 0; i < n; i++) {
    shares[participants[i]] = base + (rem > 0 ? 1 : 0);
    rem -= rem > 0 ? 1 : 0;
  }
  return shares;
}

// Tính shares 1 giao dịch (đảm bảo tổng share == total)
function computeShares(tx) {
  const total = toInt(tx.total);
  const ps = tx.participants || [];
  if (ps.length === 0) return {};

  if (tx.mode === "explicit" && tx.shares) {
    const out = {};
    ps.forEach((u) => (out[u] = Math.max(0, toInt(tx.shares[u]))));
    let diff = total - Object.values(out).reduce((a, b) => a + b, 0);
    for (let i = 0; i < ps.length && diff !== 0; i++) {
      out[ps[i]] += diff > 0 ? 1 : -1;
      diff += diff > 0 ? -1 : 1;
    }
    return out;
  }

  if (tx.mode === "weights" && tx.weights) {
    const w = ps.map((u) => Math.max(0, Number(tx.weights[u] ?? 0)));
    const sumW = w.reduce((a, b) => a + b, 0);
    if (sumW <= 0) return splitEqual(total, ps);
    const raw = w.map((wi) => Math.floor((total * wi) / sumW));
    const out = {};
    raw.forEach((v, i) => (out[ps[i]] = v));
    let assigned = raw.reduce((a, b) => a + b, 0);
    let rem = total - assigned;
    for (let i = 0; i < ps.length && rem > 0; i++, rem--) out[ps[i]] += 1;
    return out;
  }

  return splitEqual(total, ps);
}

/* =========================
   Balances & owes (CHỈ tính khoản CHƯA TRẢ)
   - Nếu participant đã "đánh dấu đã trả", khoản đó không tính vào balances/owes.
   ========================= */
function computeBalancesAndOwes(transactions) {
  const balances = {};        // {memberId: amount}
  const owes = [];            // [{from,to,amount,tx}]

  for (const tx of transactions) {
    const shares = computeShares(tx);
    const paidSet = new Set(tx.paid || []);

    for (const [uidStr, share] of Object.entries(shares)) {
      const u = Number(uidStr);
      if (u === tx.payer) continue;           // chính payer thì bỏ
      if (paidSet.has(u)) continue;           // đã trả thì bỏ
      if (share <= 0) continue;

      // chỉ cộng TRÊN KHOẢN CHƯA TRẢ
      balances[tx.payer] = (balances[tx.payer] ?? 0) + share; // sẽ được nhận
      balances[u] = (balances[u] ?? 0) - share;               // đang nợ
      owes.push({ from: u, to: tx.payer, amount: share, tx: tx.id });
    }
  }
  return { balances, owes };
}

// Gợi ý chuyển tiền (greedy)
function settleGreedy(balances) {
  const creditors = [];
  const debtors = [];
  Object.entries(balances).forEach(([name, amt]) => {
    if (amt > 0) creditors.push({ name, amt });
    else if (amt < 0) debtors.push({ name, amt: -amt });
  });
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);

  const transfers = [];
  let i = 0,
    j = 0;
  while (i < debtors.length && j < creditors.length) {
    const x = Math.min(debtors[i].amt, creditors[j].amt);
    if (x > 0) transfers.push({ from: debtors[i].name, to: creditors[j].name, amount: x });
    debtors[i].amt -= x;
    creditors[j].amt -= x;
    if (debtors[i].amt === 0) i++;
    if (creditors[j].amt === 0) j++;
  }
  return transfers;
}

/* =========================
   Storage (localStorage)
   ========================= */
const LS_MEMBERS = "mt_members_v2";
const LS_TXS = "mt_transactions_v2";
const loadMembers = () => {
  try { const s = localStorage.getItem(LS_MEMBERS); return s ? JSON.parse(s) : []; } catch { return []; }
};
const saveMembers = (arr) => localStorage.setItem(LS_MEMBERS, JSON.stringify(arr));
const loadTxs = () => {
  try { const s = localStorage.getItem(LS_TXS); return s ? JSON.parse(s) : []; } catch { return []; }
};
const saveTxs = (arr) => localStorage.setItem(LS_TXS, JSON.stringify(arr));

/* =========================
   SYNC helpers
   ========================= */
async function pullRemote() {
  if (!SYNC_URL) return null;
  const res = await fetch(`${SYNC_URL}/api/state`, {
    headers: { "x-user-id": USER_ID },
  });
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
  if (res.status === 409) {
    const data = await res.json();
    return { conflict: true, current: data.current };
  }
  if (!res.ok) throw new Error("push failed");
  const newEtag = res.headers.get("ETag");
  const data = await res.json();
  return { ...data, etag: newEtag };
}

/* =========================
   UI Atoms
   ========================= */
function Button({ children, onClick, variant="primary", className="", type="button" }) {
  const base = "inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2";
  const map = {
    primary: "bg-indigo-600 hover:bg-indigo-700 text-white focus:ring-indigo-300 focus:ring-offset-slate-900",
    ghost: "bg-transparent border border-slate-700 hover:bg-slate-800/60 text-slate-100 focus:ring-cyan-300 focus:ring-offset-slate-900",
    danger: "bg-rose-600 hover:bg-rose-700 text-white focus:ring-rose-300 focus:ring-offset-slate-900",
    subtle: "bg-slate-800 text-slate-100 border border-slate-700 hover:bg-slate-700/60 focus:ring-cyan-300 focus:ring-offset-slate-900",
  };
  return <button type={type} onClick={onClick} className={`${base} ${map[variant]} ${className}`}>{children}</button>;
}
function Input({ label, value, onChange, placeholder, type="text" }) {
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

/* =========================
   APP
   ========================= */
export default function App() {
  // Theme (dark fixed)
  const pageBg = "bg-slate-950";
  const pageText = "text-slate-100";

  // Members
  const [members, setMembers] = useState(() => {
    const local = loadMembers();
    if (Array.isArray(local) && local.length) return local;
    return [
      { id: 1, name: "Đông", color: "#4f46e5" },
      { id: 2, name: "Thế Anh", color: "#06b6d4" },
    ];
  });
  const [memberInput, setMemberInput] = useState("");

  // Transactions (tx.paid: memberId[] đã trả)
  // tx = { id, payer: memberId, total, participants:[memberId], mode:'equal'|'weights'|'explicit', weights?, shares?, paid?:[], note, ts }
  const [txs, setTxs] = useState(() => loadTxs());

  // Sync states
  const [etag, setEtag] = useState(null);
  const [version, setVersion] = useState(0);

  // Persist local
  useEffect(() => saveMembers(members), [members]);
  useEffect(() => saveTxs(txs), [txs]);

  // Initial pull
  useEffect(() => {
    (async () => {
      try {
        const remote = await pullRemote();
        if (remote?.state) {
          const m = Array.isArray(remote.state.members) ? remote.state.members : members;
          const t = Array.isArray(remote.state.transactions) ? remote.state.transactions : txs;
          setMembers(m);
          setTxs(t);
          setVersion(remote.version || 0);
          setEtag(remote.etag || null);
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push on change (debounce)
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
          setVersion(pushed.version || version + 1);
          setEtag(pushed.etag);
        }
      } catch {}
    }, 400);
    return () => clearTimeout(to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateObj]);

  // Poll pull
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

  // ===== Derived =====
  const idToName = useMemo(() => {
    const m = new Map();
    members.forEach((x) => m.set(x.id, x.name));
    return m;
  }, [members]);

  const normalizedTxs = useMemo(() => {
    return txs.map((t) => ({
      ...t,
      participants: (t.participants || []).filter((pid) => members.some((m) => m.id === pid)),
      payer: members.some((m) => m.id === t.payer) ? t.payer : (members[0]?.id ?? 0),
      paid: Array.isArray(t.paid) ? t.paid.filter((pid) => members.some((m) => m.id === pid)) : [],
      total: toInt(t.total),
    }));
  }, [txs, members]);

  const { balances, owes } = useMemo(() => computeBalancesAndOwes(normalizedTxs), [normalizedTxs]);

  const balancesList = useMemo(
    () =>
      Object.entries(balances)
        .map(([id, amt]) => ({ id: Number(id), name: idToName.get(Number(id)) ?? `#${id}`, amount: amt }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [balances, idToName]
  );

  const nameBalances = useMemo(() => {
    const obj = {};
    balancesList.forEach((b) => (obj[b.name] = b.amount));
    return obj;
  }, [balancesList]);

  const transfers = useMemo(() => settleGreedy(nameBalances), [nameBalances]);

  const totalCheck = useMemo(() => Object.values(balances).reduce((a, b) => a + b, 0), [balances]);

  // Tổng chi theo người trả (để vẽ chart)
  const spentByPayer = useMemo(() => {
    const map = new Map();
    normalizedTxs.forEach((t) => map.set(t.payer, (map.get(t.payer) || 0) + toInt(t.total)));
    return members.map((m) => ({ id: m.id, name: m.name, total: map.get(m.id) || 0 }));
  }, [normalizedTxs, members]);

  /* =========================
     Actions (Members)
     ========================= */
  const addMember = () => {
    const name = memberInput.trim();
    if (!name) return;
    if (members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      setMemberInput("");
      return;
    }
    const id = Date.now();
    const colors = ["#4f46e5", "#22d3ee", "#06b6d4", "#0ea5e9", "#a78bfa", "#6366f1", "#2dd4bf", "#38bdf8"];
    const color = colors[members.length % colors.length];
    setMembers([...members, { id, name, color }]);
    setMemberInput("");
  };

  const removeMember = (id) => {
    if (!confirm("Xóa thành viên này?")) return;
    const nextMembers = members.filter((m) => m.id !== id);
    setMembers(nextMembers);

    const remainingIds = nextMembers.map((m) => m.id);
    setTxs((arr) =>
      arr.map((t) => {
        const p = (t.participants || []).filter((pid) => pid !== id && remainingIds.includes(pid));
        const paid = (t.paid || []).filter((pid) => pid !== id && remainingIds.includes(pid));
        const newPayer = t.payer === id ? (p[0] ?? remainingIds[0] ?? 0) : t.payer;
        const patch = { ...t, participants: p, paid, payer: newPayer };
        if (t.mode === "weights" && t.weights) {
          const w = { ...t.weights }; delete w[id]; patch.weights = w;
        }
        if (t.mode === "explicit" && t.shares) {
          const s = { ...t.shares }; delete s[id]; patch.shares = s;
        }
        return patch;
      })
    );
  };

  // XÓA THÀNH VIÊN KHÔNG THUỘC GIAO DỊCH
  const removeUnusedMembers = () => {
    const used = new Set();
    normalizedTxs.forEach((t) => {
      used.add(t.payer);
      (t.participants || []).forEach((pid) => used.add(pid));
    });
    const keep = members.filter((m) => used.has(m.id));
    if (keep.length === members.length) {
      alert("Không có thành viên thừa.");
      return;
    }
    if (confirm(`Xóa ${members.length - keep.length} thành viên không thuộc giao dịch?`)) {
      setMembers(keep);
    }
  };

  /* =========================
     Actions (Transactions)
     ========================= */
  // Form draft
  const [payerDraft, setPayerDraft] = useState(0);
  const [totalDraft, setTotalDraft] = useState("");
  const [participantsDraft, setParticipantsDraft] = useState([]);
  const [modeDraft, setModeDraft] = useState("equal");
  const [weightsDraft, setWeightsDraft] = useState({});
  const [sharesDraft, setSharesDraft] = useState({});
  const [noteDraft, setNoteDraft] = useState("");

  useEffect(() => {
    if (!payerDraft && members[0]?.id) setPayerDraft(members[0].id);
    if (participantsDraft.length === 0) setParticipantsDraft(members.map((m) => m.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.length]);

  const toggleParticipantDraft = (id) => {
    setParticipantsDraft((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const onWeightDraftChange = (id, v) => setWeightsDraft((w) => ({ ...w, [id]: Number(v) }));
  const onShareDraftChange = (id, v) => setSharesDraft((s) => ({ ...s, [id]: toInt(v) }));

  const addTransaction = () => {
    const t = toInt(totalDraft);
    if (!payerDraft || !members.some((m) => m.id === payerDraft)) {
      alert("Payer không hợp lệ.");
      return;
    }
    if (t <= 0) {
      alert("Total phải > 0.");
      return;
    }
    const parts = participantsDraft.filter((pid) => members.some((m) => m.id === pid));
    if (parts.length === 0) {
      alert("Chọn ít nhất 1 participant.");
      return;
    }
    const tx = {
      id: `T${Date.now()}`,
      payer: payerDraft,
      total: t,
      participants: parts,
      mode: modeDraft,
      note: noteDraft.trim(),
      ts: new Date().toISOString(),
      paid: [], // mặc định chưa ai trả
    };
    if (modeDraft === "weights") tx.weights = { ...weightsDraft };
    if (modeDraft === "explicit") tx.shares = { ...sharesDraft };

    const shares = computeShares(tx);
    const sumShares = Object.values(shares).reduce((a, b) => a + b, 0);
    if (sumShares !== t) {
      alert("Lỗi cân tổng shares <> total. Vui lòng kiểm tra lại.");
      return;
    }

    setTxs((arr) => [tx, ...arr]);
    setTotalDraft("");
    setModeDraft("equal");
    setWeightsDraft({});
    setSharesDraft({});
    setNoteDraft("");
    setParticipantsDraft(members.map((m) => m.id));
  };

  const removeTx = (id) => {
    if (!confirm("Xóa giao dịch này?")) return;
    setTxs((arr) => arr.filter((t) => t.id !== id));
  };

  // ĐÁNH DẤU ĐÃ TRẢ / BỎ ĐÁNH DẤU
  const togglePaid = (txId, memberId) => {
    setTxs((prev) =>
      prev.map((t) => {
        if (t.id !== txId) return t;
        if (memberId === t.payer) return t; // payer không cần tick
        const parts = t.participants || [];
        if (!parts.includes(memberId)) return t;
        const set = new Set(t.paid || []);
        set.has(memberId) ? set.delete(memberId) : set.add(memberId);
        return { ...t, paid: [...set] };
      })
    );
  };

  /* =========================
     Export / Import / Backup
     ========================= */
  const downloadJSON = () => {
    const blob = new Blob([JSON.stringify({ members, transactions: txs }, null, 2)], { type: "application/json" });
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
    const rows = [["ID", "Time", "Payer", "Total(VND)", "Mode", "Participants", "Paid", "Note"]];
    for (const t of txs) {
      const payer = idToName.get(t.payer) ?? t.payer;
      const parts = (t.participants || []).map((id) => idToName.get(id) ?? id).join("; ");
      const paid = (t.paid || []).map((id) => idToName.get(id) ?? id).join("; ");
      rows.push([t.id, new Date(t.ts).toLocaleString("vi-VN"), payer, toInt(t.total), t.mode, parts, paid, t.note || ""]);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "moneytracker_transactions.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  /* =========================
     Google Drive OAuth (BACKEND trả URL)
     ========================= */
  const connectDrive = async () => {
    if (!SYNC_URL) {
      alert("Chưa cấu hình VITE_SYNC_URL");
      return;
    }
    try {
      const r = await fetch(`${SYNC_URL}/api/auth/url`, {
        headers: { "x-user-id": USER_ID },
      });
      const { url } = await r.json();
      if (url) window.open(url, "_blank", "width=520,height=640");
      else alert("Không lấy được URL liên kết Google Drive");
    } catch {
      alert("Không thể kết nối Google Drive");
    }
  };

  /* =========================
     Google Drive Sync helpers (LOAD/SAVE)
     ========================= */
  const loadFromDrive = async () => {
    if (!SYNC_URL) { alert("Chưa cấu hình VITE_SYNC_URL"); return; }
    try {
      const r = await fetch(`${SYNC_URL}/api/drive/load`, {
        headers: { "x-user-id": USER_ID },
      });
      if (!r.ok) throw new Error("drive load failed");
      const data = await r.json();
      if (data?.state) {
        const m = Array.isArray(data.state.members) ? data.state.members : [];
        const t = Array.isArray(data.state.transactions) ? data.state.transactions : [];
        setMembers(m);
        setTxs(t);
        setVersion(data.version || 0);
        setEtag(data.etag || null);
        alert("Đã đồng bộ từ Drive.");
      } else {
        alert("Không tìm thấy dữ liệu hợp lệ trên Drive.");
      }
    } catch (e) {
      alert("Không thể tải từ Drive (server chưa hỗ trợ /api/drive/load?).");
    }
  };

  const saveToDrive = async () => {
    if (!SYNC_URL) { alert("Chưa cấu hình VITE_SYNC_URL"); return; }
    try {
      const r = await fetch(`${SYNC_URL}/api/drive/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": USER_ID,
          "x-api-key": import.meta.env.VITE_SYNC_KEY || "",
        },
        body: JSON.stringify({ state: { members, transactions: txs } }),
      });
      if (!r.ok) throw new Error("drive save failed");
      alert("Đã lưu dữ liệu hiện tại lên Drive.");
    } catch (e) {
      alert("Không thể lưu lên Drive (server chưa hỗ trợ /api/drive/save?).");
    }
  };

  /* =========================
     Mobile Bottom Nav
     ========================= */
  const [tab, setTab] = useState("tx"); // tx | members | summary | charts | settings

  /* =========================
     UI
     ========================= */
  return (
    <div className={`min-h-screen ${pageBg} ${pageText} font-[Inter]`}>
      {/* Header */}
      <div className="sticky top-0 z-20 bg-slate-950/70 border-b border-slate-800 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-2xl bg-gradient-to-tr from-indigo-600 to-cyan-400 grid place-items-center font-extrabold">₫</div>
            <div className="leading-tight">
              <div className="font-semibold tracking-tight">MoneyTracker</div>
              <div className="text-xs text-slate-400">Chia tiền nhóm · VND integer</div>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2">
            <Button variant="ghost" onClick={connectDrive}>Kết nối Google Drive</Button>
            <Button variant="ghost" onClick={loadFromDrive}>Đồng bộ từ Drive</Button>
            <Button variant="ghost" onClick={saveToDrive}>Lưu lên Drive</Button>
            <Button variant="subtle" onClick={downloadJSON}>Sao lưu</Button>
            <label className="inline-flex items-center rounded-xl px-3 py-2 text-sm cursor-pointer border bg-slate-900/70 border-slate-700">
              Import JSON
              <input type="file" accept="application/json" onChange={importJSON} className="hidden" />
            </label>
            <Button variant="ghost" onClick={exportCSV}>Export CSV</Button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 pb-28 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT: Add Transaction + Members */}
        <div className="lg:col-span-1 space-y-6">
          <Card title="Thêm giao dịch" action={null}>
            <div className="grid grid-cols-1 gap-3">
              <Select label="Payer" value={payerDraft} onChange={(e) => setPayerDraft(Number(e.target.value))}>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </Select>
              <Input label="Total (VND)" value={totalDraft} onChange={(e) => setTotalDraft(e.target.value)} placeholder="vd 120000" />
              <Select label="Mode" value={modeDraft} onChange={(e) => setModeDraft(e.target.value)}>
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
                          active ? "border-emerald-400 bg-emerald-500/15" : "border-slate-700 bg-slate-900/70 hover:bg-slate-800/70"
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
                        <div className="w-28 text-sm text-slate-300">{idToName.get(pid)}</div>
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
                        <div className="w-28 text-sm text-slate-300">{idToName.get(pid)}</div>
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

              <Input label="Ghi chú" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="VD: BBQ tối T6" />

              <div className="flex items-center justify-end">
                <Button onClick={addTransaction}>Thêm giao dịch</Button>
              </div>
            </div>
          </Card>

          <Card
            title="Thành viên"
            action={
              <div className="flex items-end gap-2">
                <Input label="Thêm" value={memberInput} onChange={(e) => setMemberInput(e.target.value)} placeholder="Tên" />
                <Button onClick={addMember}>Thêm</Button>
              </div>
            }
          >
            <div className="space-y-2">
              {members.map((m) => (
                <div key={m.id} className="rounded-xl px-3 py-2 border border-slate-700 bg-slate-900/60 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-6 w-6 rounded-lg" style={{ background: m.color }} />
                    <div className="font-medium tracking-tight">{m.name}</div>
                  </div>
                  <Button variant="ghost" onClick={() => removeMember(m.id)}>Xóa</Button>
                </div>
              ))}
              {members.length === 0 && <div className="text-sm text-slate-400 text-center py-4">Chưa có thành viên</div>}
              <div className="pt-2 flex gap-2">
                <Button variant="subtle" onClick={removeUnusedMembers}>Xóa thành viên không thuộc giao dịch</Button>
              </div>
            </div>
          </Card>
        </div>

        {/* RIGHT: Tabs */}
        <div className="lg:col-span-2 space-y-6">
          {/* NAV (desktop) */}
          <Card
            title="Điều hướng"
            action={
              <div className="hidden sm:flex gap-2">
                <Button variant={tab === "tx" ? "primary" : "ghost"} onClick={() => setTab("tx")}>Lịch sử</Button>
                <Button variant={tab === "members" ? "primary" : "ghost"} onClick={() => setTab("members")}>Thành viên</Button>
                <Button variant={tab === "summary" ? "primary" : "ghost"} onClick={() => setTab("summary")}>Tổng kết</Button>
                <Button variant={tab === "charts" ? "primary" : "ghost"} onClick={() => setTab("charts")}>Charts</Button>
                <Button variant={tab === "settings" ? "primary" : "ghost"} onClick={() => setTab("settings")}>Cài đặt</Button>
              </div>
            }
          >
            <div className="text-xs text-slate-400">Tip: Trên mobile dùng thanh điều hướng dưới cùng.</div>
          </Card>

          {/* TAB: Transactions */}
          {tab === "tx" && (
            <Card
              title={`Giao dịch (${txs.length})`}
              action={
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => exportCSV()}>Export CSV</Button>
                  <Button variant="danger" onClick={() => { if (confirm("Xóa tất cả giao dịch?")) setTxs([]); }}>Xóa hết</Button>
                </div>
              }
            >
              <div className="space-y-3">
                {txs.length === 0 && <div className="text-sm text-slate-400 text-center py-6">Chưa có giao dịch.</div>}
                {normalizedTxs.map((t) => {
                  const parts = (t.participants || []).map((id) => idToName.get(id) ?? id).join(", ");
                  const payerName = idToName.get(t.payer) ?? t.payer;
                  const shares = computeShares(t);
                  return (
                    <div key={t.id} className="rounded-2xl p-3 border border-slate-700 bg-slate-900/60">
                      <div className="flex items-center justify-between">
                        <div className="font-medium tracking-tight">{t.note || "(Không ghi chú)"}</div>
                        <div className="text-sm font-semibold">{toVND(t.total)}</div>
                      </div>
                      <div className="mt-1 text-xs text-slate-400">
                        {new Date(t.ts).toLocaleString("vi-VN")} · Mode: {t.mode} · Payer: <span className="text-slate-200">{payerName}</span>
                      </div>
                      <div className="mt-1 text-xs text-slate-400">Participants: {parts}</div>

                      {/* ĐÁNH DẤU ĐÃ TRẢ */}
                      <div className="mt-3">
                        <div className="text-xs text-slate-400 mb-1">Đánh dấu đã trả</div>
                        <div className="flex flex-wrap gap-2">
                          {(t.participants || []).filter((pid) => pid !== t.payer).map((pid) => {
                            const checked = (t.paid || []).includes(pid);
                            return (
                              <label
                                key={pid}
                                className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full border text-xs ${
                                  checked ? "bg-emerald-500/10 border-emerald-400 text-emerald-300" : "border-slate-700 bg-slate-900/70 text-slate-300"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  className="accent-emerald-500"
                                  checked={checked}
                                  onChange={() => togglePaid(t.id, pid)}
                                />
                                {idToName.get(pid)}
                                <span className="opacity-70">({toVND(shares[pid] || 0)})</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      <details className="mt-3">
                        <summary className="cursor-pointer text-emerald-300 hover:underline text-sm">Xem shares</summary>
                        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {Object.entries(shares).map(([uid, a]) => (
                            <div key={uid} className="flex items-center justify-between rounded-lg px-3 py-2 bg-slate-950/40 border border-slate-700">
                              <span className="text-slate-300">{idToName.get(Number(uid)) ?? uid}</span>
                              <span className="font-semibold">{toVND(a)}</span>
                            </div>
                          ))}
                        </div>
                      </details>

                      <div className="mt-2 flex items-center justify-end">
                        <Button variant="ghost" onClick={() => removeTx(t.id)}>Xóa</Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* TAB: Members (balances) */}
          {tab === "members" && (
            <Card
              title="Số dư theo thành viên (chỉ tính khoản chưa trả)"
              action={<div className={`text-sm ${totalCheck === 0 ? "text-emerald-300" : "text-rose-300"}`}>Tổng kiểm tra: {toVND(totalCheck)}</div>}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {balancesList.map((b) => (
                  <div key={b.id} className="rounded-xl px-3 py-2 border border-slate-700 bg-slate-900/60">
                    <div className="flex items-center justify-between">
                      <div className="font-medium">{b.name}</div>
                      <div className={`font-semibold ${b.amount > 0 ? "text-emerald-300" : b.amount < 0 ? "text-rose-300" : "text-slate-300"}`}>
                        {toVND(b.amount)}
                      </div>
                    </div>
                  </div>
                ))}
                {balancesList.length === 0 && <div className="text-sm text-slate-400">Chưa có dữ liệu.</div>}
              </div>
            </Card>
          )}

          {/* TAB: Summary (transfers) */}
          {tab === "summary" && (
            <Card title="Gợi ý chuyển tiền (Greedy)" action={null}>
              {transfers.length === 0 ? (
                <div className="text-sm text-slate-400">Không cần chuyển khoản.</div>
              ) : (
                <ul className="space-y-2">
                  {transfers.map((t, i) => (
                    <li key={i} className="flex justify-between rounded-lg px-3 py-2 bg-slate-950/40 border border-slate-700">
                      <span>{t.from} → {t.to}</span>
                      <span className="font-semibold">{toVND(t.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-4 text-xs text-slate-400">* Chỉ tính các khoản chưa đánh dấu “đã trả”.</div>
            </Card>
          )}

          {/* TAB: Charts */}
          {tab === "charts" && (
            <Card title="Charts (CSS-only)" action={null}>
              {/* Helper bar component */}
              <div className="space-y-6">
                {/* Total paid by payer */}
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

                {/* Receivables / Payables */}
                <div className="grid sm:grid-cols-2 gap-6">
                  <div>
                    <div className="text-sm mb-2">Phải thu (dương)</div>
                    {balancesList.filter((b) => b.amount > 0).length === 0 && (
                      <div className="text-xs text-slate-400">—</div>
                    )}
                    <div className="space-y-2">
                      {balancesList.filter((b) => b.amount > 0).map((b) => {
                        const arr = balancesList.filter((x) => x.amount > 0);
                        const max = Math.max(1, ...arr.map((x) => x.amount));
                        const w = Math.round((b.amount / max) * 100);
                        return (
                          <div key={b.id}>
                            <div className="flex justify-between text-xs text-slate-400 mb-1">
                              <span>{b.name}</span>
                              <span>{toVND(b.amount)}</span>
                            </div>
                            <div className="h-2 rounded bg-slate-800 overflow-hidden">
                              <div className="h-2 bg-emerald-600" style={{ width: `${w}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="text-sm mb-2">Phải trả (âm)</div>
                    {balancesList.filter((b) => b.amount < 0).length === 0 && (
                      <div className="text-xs text-slate-400">—</div>
                    )}
                    <div className="space-y-2">
                      {balancesList.filter((b) => b.amount < 0).map((b) => {
                        const arr = balancesList.filter((x) => x.amount < 0).map((x) => ({ ...x, amount: -x.amount }));
                        const max = Math.max(1, ...arr.map((x) => x.amount));
                        const w = Math.round((Math.abs(b.amount) / max) * 100);
                        return (
                          <div key={b.id}>
                            <div className="flex justify-between text-xs text-slate-400 mb-1">
                              <span>{b.name}</span>
                              <span>{toVND(b.amount)}</span>
                            </div>
                            <div className="h-2 rounded bg-slate-800 overflow-hidden">
                              <div className="h-2 bg-rose-600" style={{ width: `${w}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* TAB: Settings */}
          {tab === "settings" && (
            <Card title="Cài đặt & Dữ liệu" action={null}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Button variant="ghost" onClick={connectDrive}>Kết nối Google Drive</Button>
                <Button variant="ghost" onClick={loadFromDrive}>Đồng bộ từ Drive</Button>
                <Button variant="ghost" onClick={saveToDrive}>Lưu lên Drive</Button>
                <Button variant="subtle" onClick={downloadJSON}>Sao lưu JSON</Button>
                <label className="inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm cursor-pointer border bg-slate-900/70 border-slate-700">
                  Import JSON
                  <input type="file" accept="application/json" onChange={importJSON} className="hidden" />
                </label>
                <Button variant="ghost" onClick={exportCSV}>Export CSV</Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (confirm("Xóa toàn bộ dữ liệu local?")) {
                      setTxs([]);
                      setMembers([]);
                    }
                  }}
                >
                  Reset Local
                </Button>
              </div>
              <div className="mt-4 text-xs text-slate-400">
                User: {USER_ID}
                {SYNC_URL ? ` · Sync ON (pull ${SYNC_PULL_MS}ms)` : ` · Sync OFF`}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Bottom Mobile Nav (animated) */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-800 bg-slate-950/90 backdrop-blur sm:hidden">
        {(() => {
          const items = [
            { key: "tx",       label: "Lịch sử",  icon: "🧾" },
            { key: "members",  label: "Thành viên", icon: "👥" },
            { key: "summary",  label: "Tổng kết", icon: "✅" },
            { key: "charts",   label: "Charts",   icon: "📊" },
            { key: "settings", label: "Cài đặt",  icon: "⚙️" },
          ];
          const idx = Math.max(0, items.findIndex(i => i.key === tab));
          const widthPct = 100 / items.length;
          const leftPct  = idx * widthPct;

          return (
            <div className="relative max-w-7xl mx-auto">
              {/* Animated indicator */}
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
                      className={`py-2.5 text-xs flex flex-col items-center transition-all duration-200 ${
                        active ? "text-indigo-300 scale-105" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <span className="text-lg">{it.icon}</span>
                      <span>{it.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </nav>

      <footer className="py-10 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} MoneyTracker · User: {USER_ID}
      </footer>
    </div>
  );
}

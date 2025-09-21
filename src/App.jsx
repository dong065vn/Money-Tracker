import React, { useState, useEffect, useMemo } from "react";
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ReferenceLine,
} from "recharts";

const SYNC_URL = import.meta.env.VITE_SYNC_URL;
const SYNC_KEY = import.meta.env.VITE_SYNC_KEY;
const SYNC_PULL_MS = Number(import.meta.env.VITE_SYNC_PULL_MS || 5000);

/* =========================
   ⚠️ FRONTEND CHỈ GỌI API BACKEND
   KHÔNG dùng process.env, không tạo OAuth URL ở đây
   ========================= */

// ===== USER ID (per-user) =====
const USER_ID = (() => {
  const KEY = "mt_userId";
  let v = localStorage.getItem(KEY);
  if (!v) {
    const guid = (crypto?.randomUUID?.() ?? `user-${Date.now()}`);
    v = guid;
    localStorage.setItem(KEY, v);
  }
  return v;
})();

// ===== SYNC helpers =====
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

// ===== UI atoms (theme-aware) =====
function UIButton({ children, variant = "solid", onClick, className = "", type = "button", theme = "dark" }) {
  const base =
    "inline-flex items-center justify-center rounded-3xl px-3.5 py-2.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed";
  const ring = theme === "dark" ? "focus:ring-cyan-300 focus:ring-offset-slate-900" : "focus:ring-indigo-300 focus:ring-offset-white";

  const stylesDark = {
    solid: "bg-indigo-600 hover:bg-indigo-700 text-white shadow-2xl shadow-indigo-600/20",
    ghost: "bg-transparent hover:bg-slate-800/60 text-slate-100 border border-slate-600",
    danger: "bg-rose-500 hover:bg-rose-600 text-white shadow-2xl shadow-rose-500/20",
    subtle: "bg-slate-800 text-slate-100 border border-slate-700 hover:bg-slate-700/60",
  };
  const stylesLight = {
    solid: "bg-indigo-600 hover:bg-indigo-700 text-white shadow-2xl shadow-indigo-600/20",
    ghost: "bg-transparent hover:bg-slate-100 text-slate-800 border border-slate-300",
    danger: "bg-rose-500 hover:bg-rose-600 text-white shadow-2xl shadow-rose-500/20",
    subtle: "bg-white text-slate-800 border border-slate-300 hover:bg-slate-50",
  };
  const styles = theme === "dark" ? stylesDark : stylesLight;

  return (
    <button type={type} onClick={onClick} className={`${base} ${ring} ${styles[variant]} ${className}`}>
      {children}
    </button>
  );
}

function UICard({ title, action, children, className = "", theme = "dark" }) {
  const wrap = theme === "dark" ? "bg-slate-900/70 border-slate-700" : "bg-white border-slate-200";
  const headerBorder = theme === "dark" ? "border-slate-700/60" : "border-slate-200";
  return (
    <section className={`backdrop-blur rounded-3xl border shadow-2xl shadow-black/30 ${wrap} ${className}`}>
      <div className={`flex items-center justify-between px-4 sm:px-5 py-3 border-b ${headerBorder}`}>
        <h2 className={`text-sm font-semibold tracking-wide ${theme === "dark" ? "text-slate-100" : "text-slate-800"}`}>{title}</h2>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function UIInput({ label, value, onChange, placeholder, type = "text", theme = "dark" }) {
  const cls =
    theme === "dark"
      ? "rounded-3xl bg-slate-900/70 border border-slate-700 text-slate-100 placeholder:text-slate-400 focus:ring-cyan-300"
      : "rounded-3xl bg-white border border-slate-300 text-slate-800 placeholder:text-slate-400 focus:ring-indigo-300";
  return (
    <label className="space-y-1.5 block">
      <span className={`text-xs ${theme === "dark" ? "text-slate-300" : "text-slate-600"}`}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={`w-full px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 ${cls}`}
      />
    </label>
  );
}

function UISelect({ label, value, onChange, children, theme = "dark" }) {
  const cls =
    theme === "dark"
      ? "rounded-3xl bg-slate-900/70 border border-slate-700 text-slate-100 focus:ring-cyan-300"
      : "rounded-3xl bg-white border border-slate-300 text-slate-800 focus:ring-indigo-300";
  return (
    <label className="space-y-1.5 block">
      <span className={`text-xs ${theme === "dark" ? "text-slate-300" : "text-slate-600"}`}>{label}</span>
      <select value={value} onChange={onChange} className={`w-full px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 ${cls}`}>
        {children}
      </select>
    </label>
  );
}

export default function App() {
  // ===== Design tokens =====
  const palette = useMemo(() => ["#4f46e5", "#22d3ee", "#06b6d4", "#0ea5e9", "#a78bfa", "#6366f1", "#2dd4bf", "#38bdf8"], []);

  // Theme
  const [theme, setTheme] = useState("dark");

  // ===== Data =====
  const [members, setMembers] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("mt_members")) || [
        { id: 1, name: "Đông", color: palette[0] },
        { id: 2, name: "Thế Anh", color: palette[2] },
      ];
    } catch {
      return [
        { id: 1, name: "Đông", color: palette[0] },
        { id: 2, name: "Thế Anh", color: palette[2] },
      ];
    }
  });

  const [transactions, setTransactions] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("mt_tx")) || [];
    } catch {
      return [];
    }
  });

  const [version, setVersion] = useState(0);
  const [etag, setEtag] = useState(null);
  const stateObj = useMemo(() => ({ members, transactions }), [members, transactions]);

  // ===== Sync effects =====
  useEffect(() => {
    (async () => {
      try {
        const remote = await pullRemote();
        if (remote && remote.state) {
          setMembers(remote.state.members ?? []);
          setTransactions(remote.state.transactions ?? []);
          setVersion(remote.version || 0);
          setEtag(remote.etag || null);
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    const to = setTimeout(async () => {
      try {
        const pushed = await pushRemote(stateObj, etag);
        if (pushed?.conflict) {
          const remote = await pullRemote();
          if (remote?.state) {
            setMembers(remote.state.members ?? []);
            setTransactions(remote.state.transactions ?? []);
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
  }, [stateObj]); // eslint-disable-line

  useEffect(() => {
    if (!SYNC_URL) return;
    const t = setInterval(async () => {
      try {
        const remote = await pullRemote();
        if (remote && remote.version > version) {
          setMembers(remote.state.members ?? []);
          setTransactions(remote.state.transactions ?? []);
          setVersion(remote.version);
          setEtag(remote.etag || null);
        }
      } catch {}
    }, SYNC_PULL_MS);
    return () => clearInterval(t);
  }, [version]);

  // ===== Local state =====
  const [nameInput, setNameInput] = useState("");
  const [tx, setTx] = useState({ type: "expense", amount: "", title: "", payerId: 1, participants: [] });
  const [query, setQuery] = useState("");
  const [exportMemberId, setExportMemberId] = useState(0);

  useEffect(() => localStorage.setItem("mt_members", JSON.stringify(members)), [members]);
  useEffect(() => localStorage.setItem("mt_tx", JSON.stringify(transactions)), [transactions]);

  const memberName = (id) => members.find((m) => m.id === id)?.name || "---";
  const memberIds = useMemo(() => members.map((m) => m.id), [members]);

  useEffect(() => {
    setTx((p) => ({ ...p, participants: p.participants?.length ? p.participants : memberIds }));
  }, [memberIds]);

  const nfCurrency = useMemo(() => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }), []);
  const nfNumber = useMemo(() => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }), []);
  const formatVND = (n) => nfCurrency.format(Math.round(Number(n) || 0));
  const formatInt = (n) => nfNumber.format(Math.round(Number(n) || 0));

  // ===== Actions =====
  const addMember = () => {
    if (!nameInput.trim()) return;
    const id = Date.now();
    const color = palette[members.length % palette.length];
    setMembers([...members, { id, name: nameInput.trim(), color }]);
    setNameInput("");
    setTx((p) => ({ ...p, payerId: p.payerId || id }));
  };

  const removeMember = (id) => {
    if (!confirm("Xóa thành viên này?")) return;
    const nextMembers = members.filter((m) => m.id !== id);
    setMembers(nextMembers);
    const nextIds = nextMembers.map((m) => m.id);
    setTransactions((prev) =>
      prev.map((t) => ({
        ...t,
        payerId: t.payerId === id ? nextIds[0] ?? t.payerId : t.payerId,
        paid: (t.paid || []).filter((p) => p !== id),
        participants: (t.participants || memberIds).filter((p) => p !== id),
      }))
    );
    setTx((p) => ({ ...p, payerId: p.payerId === id ? nextIds[0] ?? 0 : p.payerId, participants: (p.participants || []).filter((pid) => pid !== id) }));
  };

  const parseAmount = (val) => {
    if (val == null) return 0;
    const s = String(val);
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c >= "0" && c <= "9") out += c;
    }
    const n = parseInt(out, 10);
    return isNaN(n) ? 0 : n;
  };

  const addTransaction = () => {
    const amount = parseAmount(tx.amount);
    if (!tx.title.trim() || amount === 0 || !tx.payerId) {
      alert("Điền tiêu đề, số tiền (>0) và người trả.");
      return;
    }
    const parts = (tx.participants && tx.participants.length) ? tx.participants : memberIds;
    const newTx = {
      id: Date.now(),
      type: tx.type,
      title: tx.title.trim(),
      amount,
      payerId: tx.payerId,
      paid: [],
      participants: parts,
      date: new Date().toISOString(),
    };
    setTransactions((p) => [newTx, ...p]);
    setTx((p) => ({ ...p, title: "", amount: "", participants: memberIds }));
  };

  const removeTransaction = (id) => {
    if (!confirm("Xóa giao dịch này?")) return;
    setTransactions((p) => p.filter((t) => t.id !== id));
  };

  const togglePaid = (txId, memberId) => {
    setTransactions((prev) =>
      prev.map((t) => {
        if (t.id !== txId) return t;
        if (memberId === t.payerId) return t;
        const participants = (t.participants && t.participants.length) ? t.participants : memberIds;
        if (!participants.includes(memberId)) return t;
        const paid = new Set(t.paid || []);
        paid.has(memberId) ? paid.delete(memberId) : paid.add(memberId);
        return { ...t, paid: [...paid] };
      })
    );
  };

  const toggleParticipantInTx = (txId, memberId) => {
    setTransactions((prev) =>
      prev.map((t) => {
        if (t.id !== txId) return t;
        let participants = (t.participants && t.participants.length) ? [...t.participants] : [...memberIds];
        if (participants.includes(memberId)) {
          participants = participants.filter((p) => p !== memberId);
        } else {
          participants.push(memberId);
        }
        const paid = (t.paid || []).filter((p) => participants.includes(p));
        const payerId = participants.includes(t.payerId) ? t.payerId : participants[0] ?? t.payerId;
        return { ...t, participants, paid, payerId };
      })
    );
  };

  const toggleParticipantInDraft = (memberId) => {
    setTx((prev) => {
      const set = new Set(prev.participants?.length ? prev.participants : memberIds);
      set.has(memberId) ? set.delete(memberId) : set.add(memberId);
      return { ...prev, participants: [...set] };
    });
  };

  const clearAll = () => {
    if (!confirm("Xóa toàn bộ?")) return;
    setTransactions([]);
    setMembers([]);
  };

  // ===== Derived =====
  const balances = useMemo(() => {
    const map = new Map(members.map((m) => [m.id, 0]));
    const ids = members.map((m) => m.id);
    for (const t of transactions) {
      const payer = t.payerId;
      const participants = (t.participants && t.participants.length)
        ? t.participants.filter((id) => ids.includes(id))
        : [...ids];
      const parts = Math.max(1, participants.length);
      const share = Math.round(t.amount / parts);
      const paidSet = new Set((t.paid || []).filter((p) => participants.includes(p) && p !== payer));
      if (t.type === "expense") {
        map.set(payer, (map.get(payer) || 0) + t.amount);
        for (const p of participants) map.set(p, (map.get(p) || 0) - share);
        for (const p of paidSet) {
          map.set(p, (map.get(p) || 0) + share);
          map.set(payer, (map.get(payer) || 0) - share);
        }
      } else {
        map.set(payer, (map.get(payer) || 0) - t.amount);
        for (const p of participants) map.set(p, (map.get(p) || 0) + share);
        for (const p of paidSet) {
          map.set(p, (map.get(p) || 0) - share);
          map.set(payer, (map.get(payer) || 0) + share);
        }
      }
    }
    return Object.fromEntries(map);
  }, [members, transactions]);

  const totalsByType = useMemo(() => {
    let income = 0, expense = 0;
    for (const t of transactions) {
      if (t.type === "income") income += t.amount;
      else expense += t.amount;
    }
    return [
      { name: "Thu", value: income },
      { name: "Chi", value: expense },
    ];
  }, [transactions]);

  const expenseByPayer = useMemo(() => {
    const map = new Map();
    for (const t of transactions) {
      if (t.type !== "expense") continue;
      map.set(t.payerId, (map.get(t.payerId) || 0) + t.amount);
    }
    return members.map((m) => ({ name: m.name, total: map.get(m.id) || 0 }));
  }, [transactions, members]);

  const flowByDate = useMemo(() => {
    const fmt = (iso) => new Date(iso).toISOString().slice(0, 10);
    const map = new Map();
    for (const t of transactions) {
      const d = fmt(t.date);
      if (!map.has(d)) map.set(d, { date: d, Thu: 0, Chi: 0 });
      if (t.type === "income") map.get(d).Thu += t.amount;
      else map.get(d).Chi += t.amount;
    }
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [transactions]);

  const balancesSeries = useMemo(
    () => members.map((m, i) => ({ name: m.name, Sodu: balances[m.id] || 0, color: m.color || palette[i % palette.length] })),
    [members, balances, palette]
  );

  const avgPerMember = useMemo(() => {
    if (members.length === 0) return { avgBalance: 0, avgExpense: 0, avgIncome: 0 };
    let totalExpense = 0, totalIncome = 0;
    for (const t of transactions) {
      if (t.type === "income") totalIncome += t.amount;
      else totalExpense += t.amount;
    }
    const sumBalances = members.reduce((s, m) => s + (balances[m.id] || 0), 0);
    return {
      avgBalance: Math.round(sumBalances / members.length),
      avgExpense: Math.round(totalExpense / members.length),
      avgIncome: Math.round(totalIncome / members.length),
    };
  }, [members, transactions, balances]);

  // ===== Export/Import =====
  const exportCSV = () => {
    const rows = [["Type", "Title", "Amount(VND)", "Payer", "Participants", "Paid", "Date"]];
    for (const t of transactions) {
      const payer = memberName(t.payerId);
      const participants = (t.participants && t.participants.length ? t.participants : memberIds).map((id) => memberName(id)).join("; ");
      const paid = (t.paid || []).map((id) => memberName(id)).join("; ");
      rows.push([t.type, t.title, t.amount, payer, participants, paid, new Date(t.date).toLocaleString("vi-VN")]);
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

  const exportPersonalCSV = (memberId) => {
    if (!memberId) return;
    const rows = [["Member", "Type", "Title", "Total(VND)", "Share(VND)", "IsPayer", "Date"]];
    for (const t of transactions) {
      const participants = (t.participants && t.participants.length ? t.participants : memberIds);
      if (!participants.includes(memberId)) continue;
      const parts = Math.max(1, participants.length);
      const share = Math.round(t.amount / parts);
      const isPayer = t.payerId === memberId ? "Y" : "N";
      rows.push([memberName(memberId), t.type, t.title, t.amount, share, isPayer, new Date(t.date).toLocaleString("vi-VN")]);
    }
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `personal_${memberName(memberId)}.csv`;
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
        if (Array.isArray(data.transactions)) setTransactions(data.transactions);
        alert("Import thành công");
      } catch {
        alert("File không hợp lệ");
      }
    };
    r.readAsText(f);
  };

  const downloadJSON = () => {
    const blob = new Blob([JSON.stringify({ members, transactions }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "moneytracker_backup.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  // ===== Filtering =====
  const txFiltered = useMemo(() => {
    if (!query.trim()) return transactions;
    const q = query.trim().toLowerCase();
    return transactions.filter((t) => t.title.toLowerCase().includes(q) || memberName(t.payerId).toLowerCase().includes(q));
  }, [transactions, query]);

  // ===== Connect Google Drive (backend trả URL) =====
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

  // ===== UI tokens from theme =====
  const isDark = theme === "dark";
  const pageBg = isDark ? "bg-slate-950" : "bg-slate-50";
  const pageText = isDark ? "text-slate-100" : "text-slate-800";
  const headerBg = isDark ? "bg-slate-950/70 border-slate-800" : "bg-white/70 border-slate-200";
  const chipOn = isDark ? "bg-indigo-500/10 border-indigo-400 text-indigo-300" : "bg-indigo-50 border-indigo-300 text-indigo-700";
  const chipOff = isDark ? "bg-slate-900/70 border-slate-700 text-slate-300" : "bg-white border-slate-300 text-slate-700";
  const smallMuted = isDark ? "text-slate-400" : "text-slate-500";

  const axisTick = { fill: isDark ? "#cbd5e1" : "#475569", fontSize: 12 };
  const axisLine = { stroke: isDark ? "#475569" : "#cbd5e1" };
  const gridStroke = isDark ? "#475569" : "#e2e8f0";
  const tooltipStyle = { backgroundColor: isDark ? "#0f172a" : "#ffffff", border: `1px solid ${isDark ? "#334155" : "#e2e8f0"}`, color: isDark ? "#0ea5e9" : "#1f2937" };
  const legendStyle = { color: isDark ? "#cbd5e1" : "#334155", fontSize: 12 };

  // ===== Render =====
  return (
    <div className={`min-h-screen ${pageBg} ${pageText} font-[Inter]`}>
      {/* Header */}
      <div className={`sticky top-0 z-20 ${headerBg} backdrop-blur border-b`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-3xl bg-gradient-to-tr from-indigo-600 to-cyan-400 grid place-items-center font-bold">₫</div>
            <div className="leading-tight">
              <div className="font-semibold tracking-tight">MoneyTracker</div>
              <div className={`text-xs ${smallMuted}`}>Theo dõi & chia đều</div>
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-2">
            <UIButton theme={theme} variant="ghost" onClick={connectDrive}>Kết nối Google Drive</UIButton>
            <UIButton theme={theme} variant="subtle" onClick={downloadJSON}>Sao lưu</UIButton>
            <label className={`inline-flex items-center rounded-3xl px-3.5 py-2.5 text-sm cursor-pointer border ${isDark ? "bg-slate-900/70 border-slate-700" : "bg-white border-slate-300"}`}>
              Import JSON
              <input type="file" accept="application/json" onChange={importJSON} className="hidden" />
            </label>
            <UIButton theme={theme} variant="ghost" onClick={exportCSV}>Export CSV</UIButton>
            <UISelect theme={theme} label="Cá nhân" value={exportMemberId} onChange={(e) => setExportMemberId(Number(e.target.value))}>
              <option value={0}>Chọn thành viên</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </UISelect>
            <UIButton theme={theme} variant="ghost" onClick={() => exportPersonalCSV(exportMemberId)}>Export cá nhân</UIButton>
            <UIButton theme={theme} variant="danger" onClick={clearAll}>Reset</UIButton>
            <UIButton theme={theme} variant="ghost" onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} className="ml-1">
              {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
            </UIButton>
          </div>
        </div>
      </div>

      {/* Body */}
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Left */}
              <div className="lg:col-span-1 space-y-6">
                <UICard theme={theme}
                  title="Thành viên"
                  action={
                    <div className="flex items-end gap-2">
                      <UIInput theme={theme} label="Thêm thành viên" value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Tên" />
                      <UIButton theme={theme} onClick={addMember}>Thêm</UIButton>
                    </div>
                  }
                >
                  <div className="space-y-2">
                    {members.map((m) => (
                      <div key={m.id} className={`flex items-center justify-between rounded-3xl px-3.5 py-2.5 border ${isDark?"bg-slate-900/60 border-slate-700":"bg-white border-slate-300"}`}>
                        <div className="flex items-center gap-3">
                          <div className="h-7 w-7 rounded-xl" style={{ background: m.color }} />
                          <div className="leading-tight">
                            <div className="font-medium tracking-tight">{m.name}</div>
                            <div className={`text-xs ${smallMuted}`}>{formatVND(balances[m.id] || 0)}</div>
                          </div>
                        </div>
                        <UIButton theme={theme} variant="ghost" className="!px-2" onClick={() => removeMember(m.id)}>
                          Xóa
                        </UIButton>
                      </div>
                    ))}
                    {members.length === 0 && <div className={`text-sm ${smallMuted} text-center py-6`}>Chưa có thành viên</div>}
                  </div>
                </UICard>
      
                <UICard theme={theme} title="Thêm giao dịch">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <UISelect theme={theme} label="Loại" value={tx.type} onChange={(e) => setTx({ ...tx, type: e.target.value })}>
                      <option value="expense">Chi (Expense)</option>
                      <option value="income">Thu (Income)</option>
                    </UISelect>
                    <UIInput theme={theme} label="Số tiền (VND)" value={tx.amount} onChange={(e) => setTx({ ...tx, amount: e.target.value })} placeholder="100000" />
                    <UISelect theme={theme} label="Người trả / Thu" value={tx.payerId} onChange={(e) => setTx({ ...tx, payerId: Number(e.target.value) })}>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </UISelect>
                    <UIInput theme={theme} label="Tiêu đề" value={tx.title} onChange={(e) => setTx({ ...tx, title: e.target.value })} placeholder="Mua cafe, tiền điện..." />
                  </div>
      
                  <div className="mt-3">
                    <div className={`text-xs mb-2 ${smallMuted}`}>Thành viên tham gia</div>
                    <div className="flex flex-wrap gap-2">
                      {members.map((m) => {
                        const checked = (tx.participants || memberIds).includes(m.id);
                        return (
                          <label key={m.id} className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl border text-xs ${checked ? chipOn : chipOff}`}>
                            <input aria-label={`chọn ${m.name}`} type="checkbox" checked={checked} onChange={() => toggleParticipantInDraft(m.id)} className="accent-indigo-500" />
                            {m.name}
                          </label>
                        );
                      })}
                    </div>
                  </div>
      
                  <div className="mt-4 flex items-center justify-end">
                    <UIButton theme={theme} onClick={addTransaction}>Thêm giao dịch</UIButton>
                  </div>
                </UICard>
              </div>
      
              {/* Right */}
              <div className="lg:col-span-2 space-y-6">
                <UICard theme={theme}
                  title="Lịch sử"
                  action={<UIInput theme={theme} label="Tìm kiếm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nhập tiêu đề hoặc người trả" />}
                >
                  <div className="space-y-3">
                    {txFiltered.length === 0 && <div className={`text-sm ${smallMuted} text-center py-6`}>Không có giao dịch</div>}
                    {txFiltered.map((t) => {
                      const participants = (t.participants && t.participants.length ? t.participants : memberIds);
                      return (
                        <div key={t.id} className={`grid grid-cols-1 md:grid-cols-12 gap-3 rounded-3xl p-3.5 border ${isDark?"bg-slate-900/60 border-slate-700":"bg-white border-slate-300"}`}>
                          <div className="md:col-span-7 flex items-center gap-3">
                            <div className={`px-2.5 py-1 text-xs rounded-full border ${t.type === "income" ? "border-emerald-500 text-emerald-500" : "border-rose-500 text-rose-500"}`}>
                              {t.type === "income" ? "Thu" : "Chi"}
                            </div>
                            <div className="font-medium truncate tracking-tight">{t.title}</div>
                          </div>
                          <div className={`md:col-span-3 text-xs ${smallMuted}`}>
                            {participants.map((id) => memberName(id)).join(", ")}
                          </div>
                          <div className="md:col-span-2 text-right font-semibold">{formatVND(t.amount)}</div>
      
                          <div className="md:col-span-12 grid grid-cols-1 gap-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className={`text-xs ${smallMuted}`}>{new Date(t.date).toLocaleString("vi-VN")}</div>
                              <div className="flex items-center gap-2">
                                <span className={`text-xs ${smallMuted} mr-1`}>Payer:</span>
                                <UISelect theme={theme} label=" " value={t.payerId} onChange={(e)=>setTransactions(prev=>prev.map(x=>x.id===t.id?{...x,payerId:Number(e.target.value)}:x))}>
                                  {participants.map((id)=> <option key={id} value={id}>{memberName(id)}</option>)}
                                </UISelect>
                              </div>
                            </div>
      
                            <div>
                              <div className={`text-xs mb-1 ${smallMuted}`}>Thành viên tham gia</div>
                              <div className="flex flex-wrap gap-2">
                                {memberIds.map((pid) => {
                                  const checked = participants.includes(pid);
                                  return (
                                    <label key={pid} className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl border text-xs ${checked ? chipOn : chipOff}`}>
                                      <input aria-label={`tham gia ${memberName(pid)}`} type="checkbox" checked={checked} onChange={() => toggleParticipantInTx(t.id, pid)} className="accent-indigo-500" />
                                      {memberName(pid)}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
      
                            <div>
                              <div className={`text-xs mb-1 ${smallMuted}`}>Đánh dấu đã trả</div>
                              <div className="flex flex-wrap gap-2">
                                {participants.filter((pid) => pid !== t.payerId).map((pid) => {
                                  const checked = (t.paid || []).includes(pid);
                                  return (
                                    <label
                                      key={pid}
                                      className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl border text-xs ${
                                        checked ? (isDark?"bg-emerald-500/10 border-emerald-400 text-emerald-300":"bg-emerald-50 border-emerald-300 text-emerald-700")
                                                : chipOff
                                      }`}
                                    >
                                      <input aria-label={`đã trả ${memberName(pid)}`} type="checkbox" checked={checked} onChange={() => togglePaid(t.id, pid)} className="accent-emerald-500" />
                                      {memberName(pid)}
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
      
                            <div className="flex items-center justify-end">
                              <UIButton theme={theme} variant="ghost" onClick={() => removeTransaction(t.id)}>Xóa</UIButton>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </UICard>
      
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  <UICard theme={theme} title="Số dư từng thành viên">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {members.map((m) => (
                        <div key={m.id} className={`flex items-center justify-between rounded-3xl px-3.5 py-2.5 border ${isDark?"bg-slate-900/60 border-slate-700":"bg-white border-slate-300"}`}>
                          <div className="flex items-center gap-3">
                            <div className="h-7 w-7 rounded-xl" style={{ background: m.color }} />
                            <div className="font-medium tracking-tight">{m.name}</div>
                          </div>
                          <div className="text-right">
                            <div className={`text-sm ${isDark?"text-slate-300":"text-slate-700"}`}>{formatVND(balances[m.id] || 0)}</div>
                            <div className={`text-xs ${smallMuted}`}>{(balances[m.id] || 0) > 0 ? "Người khác nợ" : "Còn nợ"}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </UICard>
      
                  <UICard theme={theme} title="Trung bình mỗi người">
                    <div className="grid grid-cols-3 gap-4">
                      <div className={`rounded-3xl p-4 border text-center ${isDark?"bg-slate-900/60 border-slate-700":"bg-white border-slate-300"}`}>
                        <div className={`text-xs ${smallMuted}`}>Số dư bình quân</div>
                        <div className="text-lg font-semibold mt-1">{formatVND(avgPerMember.avgBalance)}</div>
                      </div>
                      <div className={`rounded-3xl p-4 border text-center ${isDark?"bg-slate-900/60 border-slate-700":"bg-white border-slate-300"}`}>
                        <div className={`text-xs ${smallMuted}`}>Chi / người</div>
                        <div className="text-lg font-semibold mt-1">{formatVND(avgPerMember.avgExpense)}</div>
                      </div>
                      <div className={`rounded-3xl p-4 border text-center ${isDark?"bg-slate-900/60 border-slate-700":"bg-white border-slate-300"}`}>
                        <div className={`text-xs ${smallMuted}`}>Thu / người</div>
                        <div className="text-lg font-semibold mt-1">{formatVND(avgPerMember.avgIncome)}</div>
                      </div>
                    </div>
                  </UICard>
                </div>
      
                <UICard theme={theme} title="Trực quan hoá">
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    {/* Pie */}
                    <div className={`rounded-3xl p-3 border h-80 ${isDark?"bg-slate-900/60 border-slate-700":"bg-white border-slate-300"}`}>
                      <div className={`text-xs mb-2 ${smallMuted}`}>Tổng Thu vs Chi</div>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <defs>
                            <linearGradient id="pg1" x1="0" x2="0" y1="0" y2="1">
                              <stop offset="0%" stopColor="#4f46e5" stopOpacity="1"/>
                              <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.6"/>
                            </linearGradient>
                            <linearGradient id="pg2" x1="0" x2="0" y1="0" y2="1">
                              <stop offset="0%" stopColor="#22d3ee" stopOpacity="1"/>
                              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.6"/>
                            </linearGradient>
                          </defs>
                          <Pie data={totalsByType} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                            {totalsByType.map((_, idx) => (
                              <Cell key={idx} fill={idx===0 ? "url(#pg1)" : "url(#pg2)"} />
                            ))}
                          </Pie>
                          <Tooltip wrapperStyle={tooltipStyle} formatter={(v) => [formatVND(v)]} />
                          <Legend wrapperStyle={legendStyle} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
      
                    {/* Bar: expense by payer */}
                    <div className={`rounded-3xl p-3 border h-80 ${isDark?"bg-slate-900/60 border-slate-700":"bg-white border-slate-300"}`}>
                      <div className={`text-xs mb-2 ${smallMuted}`}>Chi theo người trả</div>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={expenseByPayer} margin={{ top: 8, right: 8, bottom: 16, left: 8 }} barCategoryGap="25%">
                          <defs>
                            <linearGradient id="bg1" x1="0" x2="0" y1="0" y2="1">
                              <stop offset="0%" stopColor="#4f46e5" stopOpacity="1"/>
                              <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.6"/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                          <XAxis dataKey="name" tick={axisTick} axisLine={axisLine} tickLine={{ stroke: isDark ? "#475569" : "#94a3b8" }} />
                          <YAxis tickFormatter={(v) => formatInt(v)} tick={axisTick} axisLine={axisLine} tickLine={{ stroke: isDark ? "#475569" : "#94a3b8" }} />
                          <Tooltip wrapperStyle={tooltipStyle} formatter={(v) => [formatVND(v)]} />
                          <Legend wrapperStyle={legendStyle} />
                          <Bar dataKey="total" name="Tổng chi" radius={[10, 10, 0, 0]} fill="url(#bg1)" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
      
                    {/* Bar: flow by date */}
                    <div className={`rounded-3xl p-3 border h-80 xl:col-span-2 ${isDark?"bg-slate-900/60 border-slate-700":"bg-white border-slate-300"}`}>
                      <div className={`text-xs mb-2 ${smallMuted}`}>Thu/Chi theo ngày</div>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={flowByDate} margin={{ top: 8, right: 8, bottom: 16, left: 8 }} barCategoryGap="20%">
                          <defs>
                            <linearGradient id="bthu" x1="0" x2="0" y1="0" y2="1">
                              <stop offset="0%" stopColor="#22d3ee" stopOpacity="1"/>
                              <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.6"/>
                            </linearGradient>
                            <linearGradient id="bchi" x1="0" x2="0" y1="0" y2="1">
                              <stop offset="0%" stopColor="#a78bfa" stopOpacity="1"/>
                              <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.6"/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                          <XAxis dataKey="date" tick={axisTick} axisLine={axisLine} tickLine={{ stroke: isDark ? "#475569" : "#94a3b8" }} angle={-30} textAnchor="end" height={50} />
                          <YAxis tickFormatter={(v) => formatInt(v)} tick={axisTick} axisLine={axisLine} tickLine={{ stroke: isDark ? "#475569" : "#94a3b8" }} />
                          <Tooltip wrapperStyle={tooltipStyle} formatter={(v) => [formatVND(v)]} />
                          <Legend wrapperStyle={legendStyle} />
                          <Bar dataKey="Thu" stackId="a" name="Thu" radius={[10, 10, 0, 0]} fill="url(#bthu)" />
                          <Bar dataKey="Chi" stackId="a" name="Chi" radius={[10, 10, 0, 0]} fill="url(#bchi)" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
      
                    {/* Bar: balance per member */}
                    <div className={`rounded-3xl p-3 border h-80 xl:col-span-2 ${isDark?"bg-slate-900/60 border-slate-700":"bg-white border-slate-300"}`}>
                      <div className={`text-xs mb-2 ${smallMuted}`}>Số dư theo thành viên</div>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={balancesSeries} margin={{ top: 8, right: 8, bottom: 16, left: 8 }} barCategoryGap="25%">
                          <defs>
                            <linearGradient id="bbal" x1="0" x2="0" y1="0" y2="1">
                              <stop offset="0%" stopColor="#6366f1" stopOpacity="1"/>
                              <stop offset="100%" stopColor="#6366f1" stopOpacity="0.6"/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                          <XAxis dataKey="name" tick={axisTick} axisLine={axisLine} tickLine={{ stroke: isDark ? "#475569" : "#94a3b8" }} />
                          <YAxis tickFormatter={(v) => formatInt(v)} tick={axisTick} axisLine={axisLine} tickLine={{ stroke: isDark ? "#475569" : "#94a3b8" }} />
                          <ReferenceLine y={0} stroke="#94a3b8" />
                          <Tooltip wrapperStyle={tooltipStyle} formatter={(v) => [formatVND(v)]} />
                          <Legend wrapperStyle={legendStyle} />
                          <Bar dataKey="Sodu" name="Số dư" radius={[10, 10, 0, 0]} fill="url(#bbal)" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </UICard>
              </div>
            </div>

      <footer className={`py-8 text-center text-xs ${smallMuted}`}>© {new Date().getFullYear()} MoneyTracker · User: {USER_ID}</footer>
    </div>
  );
}

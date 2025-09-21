import React, { useState, useEffect, useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

const SYNC_URL = import.meta.env.VITE_SYNC_URL;
const SYNC_KEY = import.meta.env.VITE_SYNC_KEY;
const SYNC_PULL_MS = Number(import.meta.env.VITE_SYNC_PULL_MS || 5000);

async function pullRemote() {
  if (!SYNC_URL) return null;
  const res = await fetch(`${SYNC_URL}/api/state`);
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
      "If-Match": etag ?? ""
    },
    body: JSON.stringify({ state })
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

function UIButton({ children, variant = "solid", onClick, className = "", type = "button" }) {
  const base =
    "inline-flex items-center justify-center rounded-2xl px-3.5 py-2.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-sky-400 disabled:opacity-60 disabled:cursor-not-allowed";
  const styles = {
    solid: "bg-sky-500 hover:bg-sky-600 text-white shadow-md shadow-sky-500/20",
    ghost: "bg-transparent hover:bg-slate-700/60 text-slate-100 border border-slate-600",
    danger: "bg-rose-500 hover:bg-rose-600 text-white shadow-md shadow-rose-500/20",
    subtle: "bg-slate-700 hover:bg-slate-600 text-slate-100 border border-slate-600",
  };
  return (
    <button type={type} onClick={onClick} className={`${base} ${styles[variant]} ${className}`}>
      {children}
    </button>
  );
}

function UICard({ title, action, children, className = "" }) {
  return (
    <section className={`bg-slate-800/80 backdrop-blur rounded-3xl border border-slate-700 shadow-xl shadow-black/20 ${className}`}>
      <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-slate-700/60">
        <h2 className="text-sm font-semibold tracking-wide text-slate-100">{title}</h2>
        {action}
      </div>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function UIInput({ label, value, onChange, placeholder, type = "text" }) {
  return (
    <label className="space-y-1.5 block">
      <span className="text-xs text-slate-300">{label}</span>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full rounded-2xl bg-slate-900/70 border border-slate-700 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-400"
      />
    </label>
  );
}

function UISelect({ label, value, onChange, children }) {
  return (
    <label className="space-y-1.5 block">
      <span className="text-xs text-slate-300">{label}</span>
      <select
        value={value}
        onChange={onChange}
        className="w-full rounded-2xl bg-slate-900/70 border border-slate-700 px-3.5 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-400"
      >
        {children}
      </select>
    </label>
  );
}

export default function App() {
  const palette = useMemo(
    () => ["#3b82f6", "#10b981", "#3ae61c", "#c409c0", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#22c55e"],
    []
  );

  const [members, setMembers] = useState(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("mt_members")) || [
          { id: 1, name: "Đông", color: "#3b82f6" },
          { id: 2, name: "Thế Anh", color: "#10b981" },
        ]
      );
    } catch {
      return [
        { id: 1, name: "Đông", color: "#3b82f6" },
        { id: 2, name: "Thế Anh", color: "#10b981" },
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
    let to = setTimeout(async () => {
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

  const txFiltered = useMemo(() => {
    if (!query.trim()) return transactions;
    const q = query.trim().toLowerCase();
    return transactions.filter((t) => t.title.toLowerCase().includes(q) || memberName(t.payerId).toLowerCase().includes(q));
  }, [transactions, query]);

  const axisTick = { fill: "#cbd5e1", fontSize: 12 };
  const axisLine = { stroke: "#475569" };
  const gridStroke = "#475569";
  const tooltipStyle = { backgroundColor: "#0f172a", border: "1px solid #334155", color: "#e2e8f0" };
  const legendStyle = { color: "#cbd5e1" };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <div className="sticky top-0 z-20 bg-slate-900/70 backdrop-blur border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-2xl bg-gradient-to-tr from-sky-500 to-cyan-400 grid place-items-center font-bold">₫</div>
            <div className="leading-tight">
              <div className="font-semibold tracking-tight">MoneyTracker</div>
              <div className="text-xs text-slate-400">Theo dõi & chia đều</div>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2">
            <UIButton variant="subtle" onClick={downloadJSON}>Sao lưu</UIButton>
            <label className="inline-flex items-center rounded-2xl bg-slate-700 px-3.5 py-2.5 text-sm border border-slate-600 cursor-pointer">
              Import JSON
              <input type="file" accept="application/json" onChange={importJSON} className="hidden" />
            </label>
            <UIButton variant="ghost" onClick={exportCSV}>Export CSV</UIButton>
            <UISelect label="Cá nhân" value={exportMemberId} onChange={(e)=>setExportMemberId(Number(e.target.value))}>
              <option value={0}>Chọn thành viên</option>
              {members.map(m=> <option key={m.id} value={m.id}>{m.name}</option>)}
            </UISelect>
            <UIButton variant="ghost" onClick={()=>exportPersonalCSV(exportMemberId)}>Export cá nhân</UIButton>
            <UIButton variant="danger" onClick={clearAll}>Reset</UIButton>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <UICard
            title="Thành viên"
            action={
              <div className="flex items-end gap-2">
                <UIInput label="Thêm thành viên" value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Tên" />
                <UIButton onClick={addMember}>Thêm</UIButton>
              </div>
            }
          >
            <div className="space-y-2">
              {members.map((m) => (
                <div key={m.id} className="flex items-center justify-between bg-slate-900/60 rounded-2xl px-3.5 py-2.5 border border-slate-700">
                  <div className="flex items-center gap-3">
                    <div className="h-7 w-7 rounded-xl" style={{ background: m.color }} />
                    <div className="leading-tight">
                      <div className="font-medium tracking-tight">{m.name}</div>
                      <div className="text-xs text-slate-400">{formatVND(balances[m.id] || 0)}</div>
                    </div>
                  </div>
                  <UIButton variant="ghost" className="!px-2" onClick={() => removeMember(m.id)}>
                    Xóa
                  </UIButton>
                </div>
              ))}
              {members.length === 0 && <div className="text-sm text-slate-400 text-center py-6">Chưa có thành viên</div>}
            </div>
          </UICard>

          <UICard title="Thêm giao dịch">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <UISelect label="Loại" value={tx.type} onChange={(e) => setTx({ ...tx, type: e.target.value })}>
                <option value="expense">Chi (Expense)</option>
                <option value="income">Thu (Income)</option>
              </UISelect>
              <UIInput label="Số tiền (VND)" value={tx.amount} onChange={(e) => setTx({ ...tx, amount: e.target.value })} placeholder="100000" />
              <UISelect label="Người trả / Thu" value={tx.payerId} onChange={(e) => setTx({ ...tx, payerId: Number(e.target.value) })}>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </UISelect>
              <UIInput label="Tiêu đề" value={tx.title} onChange={(e) => setTx({ ...tx, title: e.target.value })} placeholder="Mua cafe, tiền điện..." />
            </div>
            <div className="mt-3">
              <div className="text-xs text-slate-400 mb-2">Thành viên tham gia</div>
              <div className="flex flex-wrap gap-2">
                {members.map((m) => {
                  const checked = (tx.participants || memberIds).includes(m.id);
                  return (
                    <label key={m.id} className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl border text-xs ${checked ? "bg-sky-500/10 border-sky-500 text-sky-300" : "bg-slate-800/80 border-slate-600 text-slate-300"}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleParticipantInDraft(m.id)} className="accent-sky-500" />
                      {m.name}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end">
              <UIButton onClick={addTransaction}>Thêm giao dịch</UIButton>
            </div>
          </UICard>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <UICard
            title="Lịch sử"
            action={<UIInput label="Tìm kiếm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nhập tiêu đề hoặc người trả" />}
          >
            <div className="space-y-3">
              {txFiltered.length === 0 && <div className="text-sm text-slate-400 text-center py-6">Không có giao dịch</div>}
              {txFiltered.map((t) => {
                const participants = (t.participants && t.participants.length ? t.participants : memberIds);
                return (
                  <div key={t.id} className="grid grid-cols-1 md:grid-cols-12 gap-3 bg-slate-900/60 rounded-2xl p-3.5 border border-slate-700">
                    <div className="md:col-span-7 flex items-center gap-3">
                      <div className={`px-2.5 py-1 text-xs rounded-full border ${t.type === "income" ? "border-emerald-500 text-emerald-400" : "border-rose-500 text-rose-400"}`}>
                        {t.type === "income" ? "Thu" : "Chi"}
                      </div>
                      <div className="font-medium truncate tracking-tight">{t.title}</div>
                    </div>
                    <div className="md:col-span-3 text-slate-300 text-xs">
                      {participants.map((id) => memberName(id)).join(", ")}
                    </div>
                    <div className="md:col-span-2 text-right font-semibold">{formatVND(t.amount)}</div>

                    <div className="md:col-span-12 grid grid-cols-1 gap-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-slate-400">{new Date(t.date).toLocaleString("vi-VN")}</div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-400 mr-1">Payer:</span>
                          <UISelect label=" " value={t.payerId} onChange={(e)=>setTransactions(prev=>prev.map(x=>x.id===t.id?{...x,payerId:Number(e.target.value)}:x))}>
                            {participants.map((id)=> <option key={id} value={id}>{memberName(id)}</option>)}
                          </UISelect>
                        </div>
                      </div>

                      <div>
                        <div className="text-xs text-slate-400 mb-1">Thành viên tham gia</div>
                        <div className="flex flex-wrap gap-2">
                          {memberIds.map((pid) => {
                            const checked = participants.includes(pid);
                            return (
                              <label key={pid} className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl border text-xs ${checked ? "bg-sky-500/10 border-sky-500 text-sky-300" : "bg-slate-800/80 border-slate-600 text-slate-300"}`}>
                                <input type="checkbox" checked={checked} onChange={() => toggleParticipantInTx(t.id, pid)} className="accent-sky-500" />
                                {memberName(pid)}
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs text-slate-400 mb-1">Đánh dấu đã trả</div>
                        <div className="flex flex-wrap gap-2">
                          {participants.filter((pid) => pid !== t.payerId).map((pid) => {
                            const checked = (t.paid || []).includes(pid);
                            return (
                              <label
                                key={pid}
                                className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-xl border text-xs ${
                                  checked ? "bg-emerald-500/10 border-emerald-500 text-emerald-300" : "bg-slate-800/80 border-slate-600 text-slate-300"
                                }`}
                              >
                                <input type="checkbox" checked={checked} onChange={() => togglePaid(t.id, pid)} className="accent-emerald-500" />
                                {memberName(pid)}
                              </label>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex items-center justify-end">
                        <UIButton variant="ghost" onClick={() => removeTransaction(t.id)}>Xóa</UIButton>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </UICard>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <UICard title="Số dư từng thành viên">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {members.map((m) => (
                  <div key={m.id} className="flex items-center justify-between bg-slate-900/60 rounded-2xl px-3.5 py-2.5 border border-slate-700">
                    <div className="flex items-center gap-3">
                      <div className="h-7 w-7 rounded-xl" style={{ background: m.color }} />
                      <div className="font-medium tracking-tight">{m.name}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-slate-300">{formatVND(balances[m.id] || 0)}</div>
                      <div className="text-xs text-slate-500">{(balances[m.id] || 0) > 0 ? "Người khác nợ" : "Còn nợ"}</div>
                    </div>
                  </div>
                ))}
              </div>
            </UICard>

            <UICard title="Trung bình mỗi người">
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-slate-900/60 rounded-2xl p-4 border border-slate-700 text-center">
                  <div className="text-xs text-slate-400">Số dư bình quân</div>
                  <div className="text-lg font-semibold mt-1">{formatVND(avgPerMember.avgBalance)}</div>
                </div>
                <div className="bg-slate-900/60 rounded-2xl p-4 border border-slate-700 text-center">
                  <div className="text-xs text-slate-400">Chi / người</div>
                  <div className="text-lg font-semibold mt-1">{formatVND(avgPerMember.avgExpense)}</div>
                </div>
                <div className="bg-slate-900/60 rounded-2xl p-4 border border-slate-700 text-center">
                  <div className="text-xs text-slate-400">Thu / người</div>
                  <div className="text-lg font-semibold mt-1">{formatVND(avgPerMember.avgIncome)}</div>
                </div>
              </div>
            </UICard>
          </div>

          <UICard title="Trực quan hoá">
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              <div className="bg-slate-900/60 rounded-2xl p-3 border border-slate-700 h-80">
                <div className="text-xs mb-2 text-slate-400">Tổng Thu vs Chi</div>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={totalsByType} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
                      {totalsByType.map((_, idx) => (
                        <Cell key={idx} fill={palette[idx % palette.length]} />
                      ))}
                    </Pie>
                    <Tooltip wrapperStyle={tooltipStyle} formatter={(v) => [formatVND(v)]} />
                    <Legend wrapperStyle={legendStyle} />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-slate-900/60 rounded-2xl p-3 border border-slate-700 h-80">
                <div className="text-xs mb-2 text-slate-400">Chi theo người trả</div>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={expenseByPayer} margin={{ top: 8, right: 8, bottom: 16, left: 8 }} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                    <XAxis dataKey="name" tick={axisTick} axisLine={axisLine} tickLine={{ stroke: "#475569" }} />
                    <YAxis tickFormatter={(v) => formatInt(v)} tick={axisTick} axisLine={axisLine} tickLine={{ stroke: "#475569" }} />
                    <Tooltip wrapperStyle={tooltipStyle} formatter={(v) => [formatVND(v)]} />
                    <Legend wrapperStyle={legendStyle} />
                    <Bar dataKey="total" name="Tổng chi" radius={[8, 8, 0, 0]}>
                      {expenseByPayer.map((_, idx) => (
                        <Cell key={idx} fill={palette[idx % palette.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-slate-900/60 rounded-2xl p-3 border border-slate-700 h-80 xl:col-span-2">
                <div className="text-xs mb-2 text-slate-400">Thu/Chi theo ngày</div>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={flowByDate} margin={{ top: 8, right: 8, bottom: 16, left: 8 }} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                    <XAxis dataKey="date" tick={axisTick} axisLine={axisLine} tickLine={{ stroke: "#475569" }} />
                    <YAxis tickFormatter={(v) => formatInt(v)} tick={axisTick} axisLine={axisLine} tickLine={{ stroke: "#475569" }} />
                    <Tooltip wrapperStyle={tooltipStyle} formatter={(v) => [formatVND(v)]} />
                    <Legend wrapperStyle={legendStyle} />
                    <Bar dataKey="Thu" stackId="a" name="Thu" radius={[8, 8, 0, 0]} fill={palette[0]} />
                    <Bar dataKey="Chi" stackId="a" name="Chi" radius={[8, 8, 0, 0]} fill={palette[3]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-slate-900/60 rounded-2xl p-3 border border-slate-700 h-80 xl:col-span-2">
                <div className="text-xs mb-2 text-slate-400">Số dư theo thành viên</div>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={balancesSeries} margin={{ top: 8, right: 8, bottom: 16, left: 8 }} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                    <XAxis dataKey="name" tick={axisTick} axisLine={axisLine} tickLine={{ stroke: "#475569" }} />
                    <YAxis tickFormatter={(v) => formatInt(v)} tick={axisTick} axisLine={axisLine} tickLine={{ stroke: "#475569" }} />
                    <ReferenceLine y={0} stroke="#94a3b8" />
                    <Tooltip wrapperStyle={tooltipStyle} formatter={(v) => [formatVND(v)]} />
                    <Legend wrapperStyle={legendStyle} />
                    <Bar dataKey="Sodu" name="Số dư" radius={[8, 8, 0, 0]}>
                      {balancesSeries.map((_, idx) => (
                        <Cell key={idx} fill={palette[idx % palette.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </UICard>
        </div>
      </div>

      <footer className="py-8 text-center text-xs text-slate-500">© {new Date().getFullYear()} MoneyTracker</footer>
    </div>
  );
}
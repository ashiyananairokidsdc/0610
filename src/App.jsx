import { useState, useEffect, useMemo, useRef } from "react";
import {
  Plus, Search, Settings, X, Trash2, Package, AlertTriangle,
  MapPin, Truck, Image as ImageIcon, Check, Tag, Boxes, Loader2, ClipboardList, Calendar,
} from "lucide-react";
import {
  collection, doc, onSnapshot, setDoc, deleteDoc,
} from "firebase/firestore";
import { db, firebaseReady } from "./firebase";

/* ---------- 定数・ヘルパー ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const defaultMasters = () => ({
  categories: [
    { id: "c-buppan", name: "物販" },
    { id: "c-shomo", name: "消耗品" },
    { id: "c-zairyo", name: "材料" },
  ],
  locations: [
    { id: "l-shinryo", name: "診療室" },
    { id: "l-tana", name: "在庫棚" },
  ],
  suppliers: [],
});

function compressImage(file, max = 480, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height) { if (width > max) { height = (height * max) / width; width = max; } }
        else { if (height > max) { width = (width * max) / height; height = max; } }
        const c = document.createElement("canvas");
        c.width = width; c.height = height;
        c.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const totalStock = (p) => Object.values(p.stock || {}).reduce((a, b) => a + num(b), 0);
// 在庫を個数に換算（stockUnit==="box" のとき箱→個）。totalStockは入力した単位そのまま
const stockPieces = (p) => totalStock(p) * (p.stockUnit === "box" ? (num(p.itemsPerBox) > 0 ? num(p.itemsPerBox) : 1) : 1);
const stockLabel = (p) => `${totalStock(p)}${p.stockUnit === "box" ? "箱" : ""}`;
const unitPrice = (p) => {
  if (p.priceMode === "unit") return num(p.unitPriceInput);
  const ipb = num(p.itemsPerBox) > 0 ? num(p.itemsPerBox) : 1;
  return num(p.boxPrice) / ipb;
};
// 発注ラインを在庫(個数)と同じ単位に換算。reorderUnit==="box" のときだけ箱→個へ変換
const reorderUnits = (p) => {
  const rl = num(p.reorderLine);
  if (p.reorderUnit === "box") {
    const ipb = num(p.itemsPerBox) > 0 ? num(p.itemsPerBox) : 1;
    return rl * ipb;
  }
  return rl;
};
const reorderLabel = (p) => `${num(p.reorderLine)}${p.reorderUnit === "box" ? "箱" : ""}`;
const needsReorder = (p) => stockPieces(p) <= reorderUnits(p);
const yen = (v, frac = 0) =>
  "¥" + Number(v || 0).toLocaleString("ja-JP", { maximumFractionDigits: frac });

// 1件の日付の状態: expired(切れ) / soon(30日以内) / ok / null(未設定)
const dateStatus = (s) => {
  if (!s) return null;
  const d = new Date(s + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.floor((d - today) / 86400000);
  if (diff < 0) return "expired";
  if (diff <= 30) return "soon";
  return "ok";
};
// 商品の期限（最大3件）。旧データ(expiry単体)も読めるよう移行対応
const getExpiries = (p) => {
  if (Array.isArray(p.expiries)) return [p.expiries[0] || "", p.expiries[1] || "", p.expiries[2] || ""];
  if (p.expiry) return [p.expiry, "", ""];
  return ["", "", ""];
};
// 3件のうち最も悪い状態を返す（切れ＞間近＞ok）
const expiryStatus = (p) => {
  const ss = getExpiries(p).filter(Boolean).map(dateStatus);
  if (ss.includes("expired")) return "expired";
  if (ss.includes("soon")) return "soon";
  if (ss.length) return "ok";
  return null;
};
const fmtDate = (s) => (s ? s.replace(/-/g, "/") : "");

const blankProduct = (masters) => ({
  id: uid(),
  image: "",
  name: "",
  categoryId: masters.categories[0]?.id || "",
  code: "",
  expiries: ["", "", ""],
  reorderLine: 0,
  reorderUnit: "piece",
  stockUnit: "piece",
  priceMode: "box",
  boxPrice: 0,
  itemsPerBox: 1,
  unitPriceInput: 0,
  supplierId: "",
  notes: "",
  stock: {},
});

/* ---------- Firestore 参照 ---------- */
const productsCol = () => collection(db, "products");
const productRef = (id) => doc(db, "products", id);
const mastersRef = () => doc(db, "config", "masters");

export default function App() {
  const [loadedP, setLoadedP] = useState(false);
  const [loadedM, setLoadedM] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const [products, setProducts] = useState([]);
  const [masters, setMasters] = useState(defaultMasters());
  const [query, setQuery] = useState("");
  const [catFilter, setCatFilter] = useState("all");
  const [editing, setEditing] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showOrders, setShowOrders] = useState(false);

  /* リアルタイム購読 */
  useEffect(() => {
    if (!firebaseReady) { setLoading(false); return; }
    const unsubP = onSnapshot(
      productsCol(),
      (snap) => {
        const arr = snap.docs.map((d) => d.data());
        arr.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja"));
        setProducts(arr);
        setLoadedP(true);
      },
      (err) => { console.error(err); setSyncError(true); setLoadedP(true); }
    );
    const unsubM = onSnapshot(
      mastersRef(),
      async (snap) => {
        if (snap.exists()) setMasters(snap.data());
        else { try { await setDoc(mastersRef(), defaultMasters()); } catch (e) { console.error(e); } }
        setLoadedM(true);
      },
      (err) => { console.error(err); setSyncError(true); setLoadedM(true); }
    );
    return () => { unsubP(); unsubM(); };
  }, []);

  useEffect(() => { if (loadedP && loadedM) setSyncError(false); }, [loadedP, loadedM]);
  const syncing = !(loadedP && loadedM);

  /* 書き込み（自動でクラウド保存→全端末に反映） */
  const saveProduct = async (p) => {
    try { await setDoc(productRef(p.id), p); }
    catch (e) { console.error(e); alert("保存に失敗しました。通信状況を確認してください。"); }
    setEditing(null);
  };
  const removeProduct = async (id) => {
    try { await deleteDoc(productRef(id)); } catch (e) { console.error(e); }
    setEditing(null);
  };
  const updateMasters = async (next, cleanup) => {
    setMasters(next); // 体感を速くするための即時反映（購読で確定）
    try { await setDoc(mastersRef(), next); } catch (e) { console.error(e); }
    if (cleanup) {
      const affected = products.map(cleanup).filter(Boolean);
      for (const p of affected) { try { await setDoc(productRef(p.id), p); } catch (e) { console.error(e); } }
    }
  };

  const catName = (id) => masters.categories.find((c) => c.id === id)?.name || "未分類";
  const locName = (id) => masters.locations.find((l) => l.id === id)?.name || "";
  const supName = (id) => masters.suppliers.find((s) => s.id === id)?.name || "";

  const reorderList = useMemo(() => products.filter(needsReorder), [products]);
  // 選択中の項目（カテゴリー）に絞った集計
  const scoped = useMemo(() => {
    if (catFilter === "reorder") return reorderList;
    if (catFilter === "all") return products;
    return products.filter((p) => p.categoryId === catFilter);
  }, [products, catFilter, reorderList]);
  const scopedReorder = useMemo(() => scoped.filter(needsReorder), [scoped]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (catFilter === "reorder" && !needsReorder(p)) return false;
      if (catFilter !== "all" && catFilter !== "reorder" && p.categoryId !== catFilter) return false;
      if (!q) return true;
      return (
        (p.name || "").toLowerCase().includes(q) ||
        (p.code || "").toLowerCase().includes(q) ||
        catName(p.categoryId).toLowerCase().includes(q) ||
        supName(p.supplierId).toLowerCase().includes(q)
      );
    });
  }, [products, query, catFilter, masters]);

  if (!firebaseReady) return <SetupScreen />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 shrink-0 mr-auto">
              <div className="w-9 h-9 rounded-xl bg-teal-600 flex items-center justify-center text-white">
                <Boxes className="w-5 h-5" />
              </div>
              <div className="leading-tight">
                <div className="font-bold tracking-tight">在庫管理</div>
                <div className="text-[11px] text-slate-400 flex items-center gap-1">
                  {syncing ? (<><Loader2 className="w-3 h-3 animate-spin" /> 同期中…</>) : "歯科医院"}
                </div>
              </div>
            </div>
            <button onClick={() => setShowOrders(true)} title="発注リスト" className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100 shrink-0">
              <ClipboardList className="w-5 h-5" />
              {reorderList.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center tabular-nums">
                  {reorderList.length}
                </span>
              )}
            </button>
            <button onClick={() => setShowSettings(true)} title="マスタ管理" className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 shrink-0">
              <Settings className="w-5 h-5" />
            </button>
            <button
              onClick={() => setEditing(blankProduct(masters))}
              className="shrink-0 inline-flex items-center gap-1.5 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium px-3 sm:px-3.5 py-2 rounded-lg"
            >
              <Plus className="w-4 h-4" /> <span className="hidden sm:inline">商品を追加</span>
            </button>
          </div>
          <div className="relative mt-3">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="商品名・コード・発注先で検索"
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-100 text-sm outline-none focus:ring-2 focus:ring-teal-500 focus:bg-white"
            />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5">
        {syncError && (
          <div className="mb-4 text-xs bg-red-50 text-red-700 border border-red-200 rounded-lg px-3 py-2 leading-relaxed">
            クラウド（Firebase）と同期できていません。Firebase コンソールで Firestore のルールが
            「allow read, write: if true」で公開されているか確認してください。
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <Stat label="登録商品数" value={scoped.length} unit="点" icon={<Package className="w-4 h-4" />} />
          <button onClick={() => setCatFilter("reorder")} className="text-left">
            <Stat label="要発注" value={scopedReorder.length} unit="点" alert={scopedReorder.length > 0} icon={<AlertTriangle className="w-4 h-4" />} />
          </button>
        </div>

        {scopedReorder.length > 0 && catFilter !== "reorder" && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-3">
            <div className="flex items-center gap-2 text-amber-800 font-medium text-sm mb-2">
              <AlertTriangle className="w-4 h-4" /> 発注ライン以下の商品が {scopedReorder.length} 点あります
            </div>
            <div className="flex flex-wrap gap-2">
              {scopedReorder.map((p) => (
                <button key={p.id} onClick={() => setEditing({ ...p, stock: { ...p.stock } })}
                  className="text-xs bg-white border border-amber-200 rounded-full px-3 py-1 hover:bg-amber-100">
                  {p.name || "（無名）"}：残 <span className="font-semibold tabular-nums">{stockLabel(p)}</span>
                  <span className="text-slate-400"> / 発注ライン {reorderLabel(p)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mb-4">
          <Chip active={catFilter === "all"} onClick={() => setCatFilter("all")}>すべて</Chip>
          {masters.categories.map((c) => (
            <Chip key={c.id} active={catFilter === c.id} onClick={() => setCatFilter(c.id)}>{c.name}</Chip>
          ))}
          {reorderList.length > 0 && (
            <Chip active={catFilter === "reorder"} onClick={() => setCatFilter("reorder")} alert>要発注のみ</Chip>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="text-center py-20 text-slate-400">
            <Package className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">該当する商品はありません。</p>
            <button onClick={() => setEditing(blankProduct(masters))} className="mt-3 text-teal-600 text-sm font-medium hover:underline">
              最初の商品を追加する
            </button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => (
              <ProductCard key={p.id} p={p} catName={catName(p.categoryId)} supName={supName(p.supplierId)}
                locName={locName} onEdit={() => setEditing({ ...p, stock: { ...p.stock } })} />
            ))}
          </div>
        )}
      </main>

      {editing && (
        <Editor
          product={editing} masters={masters} onChange={setEditing}
          onSave={saveProduct} onDelete={removeProduct} onClose={() => setEditing(null)}
          isNew={!products.some((x) => x.id === editing.id)}
          onQuickAddMaster={async (kind, name) => {
            const id = (kind === "locations" ? "l-" : "s-") + uid();
            await updateMasters({ ...masters, [kind]: [...masters[kind], { id, name }] });
            return id;
          }}
        />
      )}

      {showOrders && <OrderList products={products} onClose={() => setShowOrders(false)} supName={supName} />}

      {showSettings && (
        <SettingsModal masters={masters} products={products} onClose={() => setShowSettings(false)} updateMasters={updateMasters} />
      )}
    </div>
  );
}

/* ---------- セットアップ未完了画面 ---------- */
function SetupScreen() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6 text-slate-700">
      <div className="max-w-md bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <div className="w-10 h-10 rounded-xl bg-teal-600 text-white flex items-center justify-center mb-3">
          <Boxes className="w-5 h-5" />
        </div>
        <h1 className="font-bold text-lg mb-2">Firebase の設定が必要です</h1>
        <p className="text-sm text-slate-500 leading-relaxed">
          環境変数（VITE_FIREBASE_*）が読み込めませんでした。README の手順に沿って Firebase プロジェクトを作成し、
          ローカルでは <code className="bg-slate-100 px-1 rounded">.env</code>、Vercel では「Environment Variables」に
          設定してから再ビルドしてください。
        </p>
      </div>
    </div>
  );
}

/* ---------- 以降のUIコンポーネント ---------- */
function Stat({ label, value, unit, icon, alert }) {
  return (
    <div className={`rounded-xl border p-3 sm:p-4 h-full ${alert ? "border-amber-300 bg-amber-50" : "border-slate-200 bg-white"}`}>
      <div className={`flex items-center gap-1.5 text-xs mb-1 ${alert ? "text-amber-700" : "text-slate-400"}`}>{icon}{label}</div>
      <div className={`text-xl sm:text-2xl font-bold tabular-nums ${alert ? "text-amber-700" : "text-slate-800"}`}>
        {value}<span className="text-sm font-medium ml-0.5">{unit}</span>
      </div>
    </div>
  );
}

function Chip({ children, active, onClick, alert }) {
  return (
    <button onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-colors ${
        active ? (alert ? "bg-amber-500 border-amber-500 text-white" : "bg-teal-600 border-teal-600 text-white")
               : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"}`}>
      {children}
    </button>
  );
}

function ProductCard({ p, catName, supName, locName, onEdit }) {
  const low = needsReorder(p);
  const ex = expiryStatus(p);
  const locs = Object.entries(p.stock || {}).filter(([, q]) => num(q) > 0);
  return (
    <button onClick={onEdit}
      className="text-left bg-white rounded-xl border border-slate-200 hover:border-teal-400 hover:shadow-sm transition-all overflow-hidden flex flex-col">
      <div className="flex gap-3 p-3">
        <div className="w-16 h-16 rounded-lg bg-slate-100 shrink-0 overflow-hidden flex items-center justify-center">
          {p.image ? <img src={p.image} alt="" loading="lazy" className="w-full h-full object-cover" /> : <ImageIcon className="w-6 h-6 text-slate-300" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 font-medium shrink-0">{catName}</span>
            {low && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium shrink-0 inline-flex items-center gap-0.5">
                <AlertTriangle className="w-3 h-3" /> 要発注
              </span>
            )}
            {(ex === "expired" || ex === "soon") && (
              <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium shrink-0 inline-flex items-center gap-0.5 ${ex === "expired" ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700"}`}>
                <Calendar className="w-3 h-3" /> {ex === "expired" ? "期限切れ" : "期限間近"}
              </span>
            )}
          </div>
          <div className="font-semibold text-slate-800 break-words mt-1">{p.name || "（無名）"}</div>
          <div className="text-xs text-slate-400 truncate">{p.code || "コード未設定"}</div>
        </div>
      </div>
      <div className="px-3 pb-3 mt-auto">
        <div className="flex items-end justify-between border-t border-slate-100 pt-2">
          <div>
            <div className="text-[11px] text-slate-400">在庫数</div>
            <div className={`text-2xl font-bold tabular-nums leading-none ${low ? "text-amber-600" : "text-slate-800"}`}>
              {stockLabel(p)}<span className="text-xs font-medium text-slate-400 ml-1">/ 発注 {reorderLabel(p)}</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-slate-400">単価</div>
            <div className="font-semibold tabular-nums">{yen(unitPrice(p), 1)}</div>
            <div className="text-[11px] text-slate-400 tabular-nums">{p.priceMode === "unit" ? "1個単位" : `箱 ${yen(p.boxPrice)}`}</div>
          </div>
        </div>
        {locs.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {locs.map(([lid, q]) => (
              <span key={lid} className="inline-flex items-center gap-1 text-[11px] bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
                {locName(lid) || "?"} <span className="font-semibold tabular-nums">{num(q)}{p.stockUnit === "box" ? "箱" : ""}</span>
              </span>
            ))}
          </div>
        )}
        {getExpiries(p).some(Boolean) && (
          <div className={`flex items-center gap-1 text-[11px] mt-2 ${ex === "expired" ? "text-red-600 font-medium" : ex === "soon" ? "text-orange-600 font-medium" : "text-slate-400"}`}>
            <Calendar className="w-3 h-3" /> 期限 {getExpiries(p).filter(Boolean).map(fmtDate).join(" / ")}
          </div>
        )}
        {supName && (
          <div className="flex items-center gap-1 text-[11px] text-slate-400 mt-2"><Truck className="w-3 h-3" /> {supName}</div>
        )}
      </div>
    </button>
  );
}

function Editor({ product, masters, onChange, onSave, onDelete, onClose, isNew, onQuickAddMaster }) {
  const fileRef = useRef(null);
  const [imgBusy, setImgBusy] = useState(false);
  const set = (patch) => onChange({ ...product, ...patch });
  const setStock = (lid, v) => onChange({ ...product, stock: { ...product.stock, [lid]: v } });
  const setExpiry = (i, v) => { const arr = [...getExpiries(product)]; arr[i] = v; onChange({ ...product, expiries: arr }); };

  const handleImage = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setImgBusy(true);
    try { set({ image: await compressImage(f) }); } catch (err) { console.error(err); } finally { setImgBusy(false); }
  };

  const up = unitPrice(product);

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white h-full shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 shrink-0">
          <h2 className="font-bold">{isNew ? "商品を追加" : "商品を編集"}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
          <div className="flex gap-3 items-center">
            <div className="w-20 h-20 rounded-lg bg-slate-100 overflow-hidden flex items-center justify-center shrink-0">
              {imgBusy ? <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                : product.image ? <img src={product.image} alt="" className="w-full h-full object-cover" />
                : <ImageIcon className="w-7 h-7 text-slate-300" />}
            </div>
            <div className="space-y-1.5">
              <input ref={fileRef} type="file" accept="image/*" onChange={handleImage} className="hidden" />
              <button onClick={() => fileRef.current?.click()} className="text-sm px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50">画像を選択</button>
              {product.image && (
                <button onClick={() => set({ image: "" })} className="block text-xs text-slate-400 hover:text-red-500">画像を削除</button>
              )}
            </div>
          </div>

          <Field label="商品名">
            <input value={product.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} placeholder="例）ミラー" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="項目">
              <select value={product.categoryId} onChange={(e) => set({ categoryId: e.target.value })} className={inputCls}>
                {masters.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="コード">
              <input value={product.code} onChange={(e) => set({ code: e.target.value })} className={inputCls} placeholder="例）A-001" />
            </Field>
          </div>

          <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 space-y-3">
            <div className="flex gap-1 bg-slate-100 p-0.5 rounded-lg">
              <button onClick={() => set({ priceMode: "box" })}
                className={`flex-1 py-1.5 text-sm rounded-md font-medium ${product.priceMode !== "unit" ? "bg-white text-teal-700 shadow-sm" : "text-slate-500"}`}>箱単位</button>
              <button onClick={() => set({ priceMode: "unit" })}
                className={`flex-1 py-1.5 text-sm rounded-md font-medium ${product.priceMode === "unit" ? "bg-white text-teal-700 shadow-sm" : "text-slate-500"}`}>1個単位</button>
            </div>
            {product.priceMode === "unit" ? (
              <Field label="単価（1個あたりの価格・円）">
                <input type="number" min="0" value={product.unitPriceInput} onChange={(e) => set({ unitPriceInput: e.target.value })} className={inputCls} />
              </Field>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="1箱あたりの価格（円）">
                    <input type="number" min="0" value={product.boxPrice} onChange={(e) => set({ boxPrice: e.target.value })} className={inputCls} />
                  </Field>
                  <Field label="1箱の入数">
                    <input type="number" min="1" value={product.itemsPerBox} onChange={(e) => set({ itemsPerBox: e.target.value })} className={inputCls} />
                  </Field>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-500">自動計算された単価</span>
                  <span className="font-bold text-teal-700 tabular-nums">{yen(up, 2)} / 個</span>
                </div>
              </>
            )}
          </div>

          <Field label="発注ライン（この数量以下になると通知）">
            <div className="flex gap-2">
              <input type="number" min="0" value={product.reorderLine} onChange={(e) => set({ reorderLine: e.target.value })} className={inputCls} />
              <div className="flex gap-1 bg-slate-100 p-0.5 rounded-lg shrink-0">
                <button onClick={() => set({ reorderUnit: "piece" })}
                  className={`px-3 text-sm rounded-md font-medium ${product.reorderUnit !== "box" ? "bg-white text-teal-700 shadow-sm" : "text-slate-500"}`}>個数</button>
                <button onClick={() => set({ reorderUnit: "box" })}
                  className={`px-3 text-sm rounded-md font-medium ${product.reorderUnit === "box" ? "bg-white text-teal-700 shadow-sm" : "text-slate-500"}`}>箱数</button>
              </div>
            </div>
            {product.reorderUnit === "box" && (
              <div className="text-[11px] text-slate-400 mt-1">
                1箱 {num(product.itemsPerBox) > 0 ? num(product.itemsPerBox) : 1}個 ＝ 在庫 {reorderUnits(product)} 個以下で通知
              </div>
            )}
          </Field>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">使用期限</label>
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-sm text-slate-500 w-5 shrink-0 text-center">{["①", "②", "③"][i]}</span>
                  <input type="date" value={getExpiries(product)[i]} onChange={(e) => setExpiry(i, e.target.value)} className={inputCls} />
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-500">保管場所ごとの在庫数</label>
              <div className="flex items-center gap-2">
                <div className="flex gap-1 bg-slate-100 p-0.5 rounded-md">
                  <button onClick={() => set({ stockUnit: "piece" })}
                    className={`px-2 py-0.5 text-xs rounded font-medium ${product.stockUnit !== "box" ? "bg-white text-teal-700 shadow-sm" : "text-slate-500"}`}>個数</button>
                  <button onClick={() => set({ stockUnit: "box" })}
                    className={`px-2 py-0.5 text-xs rounded font-medium ${product.stockUnit === "box" ? "bg-white text-teal-700 shadow-sm" : "text-slate-500"}`}>箱数</button>
                </div>
                <span className="text-xs text-slate-400">合計 <span className="font-semibold tabular-nums text-slate-600">{stockLabel(product)}</span></span>
              </div>
            </div>
            <div className="space-y-2">
              {masters.locations.length === 0 && <p className="text-xs text-slate-400">保管場所が未登録です。下から追加してください。</p>}
              {masters.locations.map((l) => (
                <div key={l.id} className="flex items-center gap-2">
                  <span className="flex-1 inline-flex items-center gap-1.5 text-sm text-slate-700"><MapPin className="w-4 h-4 text-slate-400" />{l.name}</span>
                  <input type="number" min="0" value={product.stock[l.id] ?? ""} onChange={(e) => setStock(l.id, e.target.value)} placeholder="0"
                    className="w-24 text-right px-2 py-1.5 rounded-lg border border-slate-200 text-sm tabular-nums outline-none focus:ring-2 focus:ring-teal-500" />
                  <span className="text-xs text-slate-400 w-4">{product.stockUnit === "box" ? "箱" : "個"}</span>
                </div>
              ))}
            </div>
            {product.stockUnit === "box" && (
              <div className="text-[11px] text-slate-400 mt-1">1箱 {num(product.itemsPerBox) > 0 ? num(product.itemsPerBox) : 1}個 ＝ 在庫 {stockPieces(product)} 個</div>
            )}
            <QuickAdd label="＋ 保管場所を追加" onAdd={(name) => onQuickAddMaster("locations", name)} />
          </div>

          <Field label="発注先">
            <select value={product.supplierId} onChange={(e) => set({ supplierId: e.target.value })} className={inputCls}>
              <option value="">（未設定）</option>
              {masters.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <QuickAdd label="＋ 発注先を追加" onAdd={async (name) => { const id = await onQuickAddMaster("suppliers", name); set({ supplierId: id }); }} />
          </Field>

          <Field label="備考">
            <textarea value={product.notes} onChange={(e) => set({ notes: e.target.value })} rows={3} className={inputCls + " resize-none"} placeholder="メモ・規格など" />
          </Field>

          {!isNew && (
            <button onClick={() => { if (confirm("この商品を削除しますか？")) onDelete(product.id); }}
              className="w-full inline-flex items-center justify-center gap-1.5 text-red-600 text-sm py-2 rounded-lg border border-red-200 hover:bg-red-50">
              <Trash2 className="w-4 h-4" /> この商品を削除
            </button>
          )}
        </div>

        <div className="border-t border-slate-200 p-3 shrink-0 flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50">キャンセル</button>
          <button onClick={() => onSave(product)} className="flex-[2] py-2.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium inline-flex items-center justify-center gap-1.5">
            <Check className="w-4 h-4" /> 保存する
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls = "w-full px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-teal-500";

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function QuickAdd({ label, onAdd }) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const submit = async () => { const name = val.trim(); if (!name) return; await onAdd(name); setVal(""); setOpen(false); };
  if (!open) return <button onClick={() => setOpen(true)} className="mt-2 text-xs text-teal-600 font-medium hover:underline">{label}</button>;
  return (
    <div className="mt-2 flex gap-2">
      <input autoFocus value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="名称を入力"
        className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-teal-500" />
      <button onClick={submit} className="px-3 rounded-lg bg-teal-600 text-white text-sm">追加</button>
      <button onClick={() => { setOpen(false); setVal(""); }} className="px-2 text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
    </div>
  );
}

/* ---------- 発注リスト ---------- */
function OrderList({ products, onClose, supName }) {
  const items = useMemo(() => products.filter(needsReorder), [products]);
  const [qty, setQty] = useState({});
  const [copied, setCopied] = useState("");

  useEffect(() => {
    setQty((prev) => {
      const next = { ...prev };
      items.forEach((p) => { if (next[p.id] == null) next[p.id] = Math.max(reorderUnits(p) - stockPieces(p), 1); });
      return next;
    });
  }, [items]);

  const groups = useMemo(() => {
    const g = {};
    items.forEach((p) => { const k = p.supplierId || "__none__"; (g[k] = g[k] || []).push(p); });
    return g;
  }, [items]);

  const groupName = (k) => (k === "__none__" ? "発注先未設定" : supName(k) || "発注先未設定");
  const lineQty = (p) => Math.max(num(qty[p.id]), 0);

  const buildText = (k, list) => {
    let t = `【${groupName(k)}】\n`;
    list.forEach((p) => { t += `・${p.name || "（無名）"}${p.code ? ` (${p.code})` : ""} × ${lineQty(p)}\n`; });
    return t.trim();
  };

  const copy = async (text, key) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1500); } catch (e) { console.error(e); }
  };

  const allText = Object.entries(groups).map(([k, l]) => buildText(k, l)).join("\n\n");

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 shrink-0">
          <h2 className="font-bold flex items-center gap-2"><ClipboardList className="w-4 h-4" /> 発注リスト</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4 space-y-4 flex-1">
          {items.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              <Check className="w-10 h-10 mx-auto mb-3 text-teal-500 opacity-60" />
              <p className="text-sm">発注が必要な商品はありません。</p>
            </div>
          ) : (
            Object.entries(groups).map(([k, list]) => {
              const subtotal = list.reduce((a, p) => a + lineQty(p) * unitPrice(p), 0);
              return (
                <div key={k} className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between bg-slate-50 px-3 py-2 border-b border-slate-200">
                    <span className="font-semibold text-sm flex items-center gap-1.5"><Truck className="w-4 h-4 text-slate-400" />{groupName(k)}</span>
                    <button onClick={() => copy(buildText(k, list), k)} className="text-xs text-teal-600 font-medium hover:underline">
                      {copied === k ? "コピーしました" : "コピー"}
                    </button>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {list.map((p) => (
                      <div key={p.id} className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">{p.name || "（無名）"}</div>
                          <div className="text-[11px] text-slate-400 tabular-nums">
                            {p.code ? p.code + " ・ " : ""}残 {stockLabel(p)} / 発注ライン {reorderLabel(p)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-[11px] text-slate-400">発注</span>
                          <input type="number" min="0" value={qty[p.id] ?? ""} onChange={(e) => setQty((q) => ({ ...q, [p.id]: e.target.value }))}
                            className="w-16 text-right px-2 py-1 rounded-lg border border-slate-200 text-sm tabular-nums outline-none focus:ring-2 focus:ring-teal-500" />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between px-3 py-2 bg-slate-50 text-xs text-slate-500 border-t border-slate-200">
                    <span>{list.length}品目</span>
                    <span className="tabular-nums">概算 {yen(subtotal)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {items.length > 0 && (
          <div className="border-t border-slate-200 p-3 shrink-0 flex gap-2">
            <button onClick={() => copy(allText, "__all__")} className="flex-1 py-2.5 rounded-lg border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50">
              {copied === "__all__" ? "コピーしました" : "全体をコピー"}
            </button>
            <button onClick={onClose} className="flex-1 py-2.5 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-900">閉じる</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- マスタ管理 ---------- */
function SettingsModal({ masters, products, onClose, updateMasters }) {
  const sections = [
    { key: "categories", title: "項目（カテゴリー）", icon: <Tag className="w-4 h-4" />, prefix: "c-" },
    { key: "locations", title: "保管場所", icon: <MapPin className="w-4 h-4" />, prefix: "l-" },
    { key: "suppliers", title: "発注先", icon: <Truck className="w-4 h-4" />, prefix: "s-" },
  ];

  const usageCount = (key, id) => {
    if (key === "categories") return products.filter((p) => p.categoryId === id).length;
    if (key === "suppliers") return products.filter((p) => p.supplierId === id).length;
    return products.filter((p) => num(p.stock?.[id]) > 0).length;
  };

  const addItem = (key, prefix) => async (name) => {
    const id = prefix + uid();
    await updateMasters({ ...masters, [key]: [...masters[key], { id, name }] });
  };
  const renameItem = async (key, id, name) => {
    await updateMasters({ ...masters, [key]: masters[key].map((x) => (x.id === id ? { ...x, name } : x)) });
  };
  const deleteItem = async (key, id) => {
    const cnt = usageCount(key, id);
    if (cnt > 0 && !confirm(`${cnt}件の商品で使用中です。削除すると、その商品から外れます。続けますか？`)) return;
    const next = { ...masters, [key]: masters[key].filter((x) => x.id !== id) };
    const cleanup = (p) => {
      if (key === "categories" && p.categoryId === id) return { ...p, categoryId: next.categories[0]?.id || "" };
      if (key === "suppliers" && p.supplierId === id) return { ...p, supplierId: "" };
      if (key === "locations" && id in (p.stock || {})) { const s = { ...p.stock }; delete s[id]; return { ...p, stock: s }; }
      return null;
    };
    await updateMasters(next, cleanup);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 shrink-0">
          <h2 className="font-bold flex items-center gap-2"><Settings className="w-4 h-4" /> マスタ管理</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500"><X className="w-5 h-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4 space-y-6">
          {sections.map((sec) => (
            <div key={sec.key}>
              <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5 mb-2">{sec.icon}{sec.title}</h3>
              <div className="space-y-1.5">
                {masters[sec.key].length === 0 && <p className="text-xs text-slate-400">まだ登録がありません。</p>}
                {masters[sec.key].map((item) => (
                  <MasterRow key={item.id} item={item} count={usageCount(sec.key, item.id)}
                    onRename={(name) => renameItem(sec.key, item.id, name)} onDelete={() => deleteItem(sec.key, item.id)} />
                ))}
              </div>
              <QuickAdd label={`＋ ${sec.title}を追加`} onAdd={addItem(sec.key, sec.prefix)} />
            </div>
          ))}
        </div>
        <div className="border-t border-slate-200 p-3 shrink-0">
          <button onClick={onClose} className="w-full py-2.5 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-900">閉じる</button>
        </div>
      </div>
    </div>
  );
}

function MasterRow({ item, count, onRename, onDelete }) {
  const [val, setVal] = useState(item.name);
  useEffect(() => setVal(item.name), [item.name]);
  return (
    <div className="flex items-center gap-2">
      <input value={val} onChange={(e) => setVal(e.target.value)}
        onBlur={() => { const n = val.trim(); if (n && n !== item.name) onRename(n); else setVal(item.name); }}
        className="flex-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-teal-500" />
      <span className="text-xs text-slate-400 tabular-nums w-12 text-right">{count}件</span>
      <button onClick={onDelete} className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg"><Trash2 className="w-4 h-4" /></button>
    </div>
  );
}

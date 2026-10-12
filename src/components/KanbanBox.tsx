import React, { useRef, useState, useEffect } from 'react';
import { PackageMinus, PackagePlus, Trash2, Clock, Activity, AlertTriangle, FileQuestion, ArrowDownToLine, ArrowUpFromLine, CheckCircle2 } from 'lucide-react';
import { KanbanItem, Transaction } from '../db';
import { cn } from '../lib/utils';
import { fetchItemHistory } from '../socket';

export interface KanbanBoxProps {
  key?: string | number;
  item: KanbanItem; 
  onTake: () => void; 
  onAdd: () => void;
  onDelete: () => void; 
  onEdit: () => void; 
  canManage: boolean;
  canDelete: boolean;
  canTake: boolean;
  canAdd: boolean;
  alertThreshold: number;
  picturePosition?: string;
  pictureScale?: number;
  isBulkMode?: boolean;
  bulkSelectionQty?: number;
  onBulkSelect?: () => void;
  dragHandle?: React.ReactNode;
}

export default function KanbanBox({ 
  item, 
  onTake, 
  onAdd,
  onDelete, 
  onEdit, 
  canManage,
  canDelete,
  canTake,
  canAdd,
  alertThreshold,
  picturePosition = '50% 50%',
  pictureScale = 1.0,
  isBulkMode = false,
  bulkSelectionQty = 0,
  onBulkSelect,
  dragHandle
}: KanbanBoxProps) {
  const isCritical = item.quantity <= item.securityLimit;
  const isApproaching = !isCritical && item.quantity <= item.securityLimit * (alertThreshold / 100);

  const percentage = Math.min((item.quantity / (item.securityLimit * (alertThreshold / 100)) * 100) || 0, 100);

  const [isPressing, setIsPressing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const pressTimer = useRef<NodeJS.Timeout | null>(null);

  const [history, setHistory] = useState<Transaction[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    if (!showHistory || !item.id) return;
    
    let cancelled = false;
    setLoadingHistory(true);

    fetchItemHistory(item.id, 20).then((txs) => {
      if (!cancelled) {
        setHistory(txs);
        setLoadingHistory(false);
      }
    }).catch((err) => {
      console.error('Error fetching box history:', err);
      if (!cancelled) setLoadingHistory(false);
    });

    return () => {
      cancelled = true;
    };
  }, [item.id, showHistory]);

  const handlePointerDown = () => {
    if (!canManage) return;
    setIsPressing(true);
    pressTimer.current = setTimeout(() => {
      setIsPressing(false);
      onEdit();
    }, 2000);
  };

  const handlePointerUp = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
    }
    setIsPressing(false);
  };

  return (
    <>
      <div
        onClick={isBulkMode ? onBulkSelect : undefined}
        onPointerDown={isBulkMode ? undefined : handlePointerDown}
        onPointerUp={isBulkMode ? undefined : handlePointerUp}
        onPointerLeave={isBulkMode ? undefined : handlePointerUp}
        onContextMenu={(e) => { e.preventDefault(); }} // Prevent mobile context menu on long press
        className={cn(
          "group relative flex flex-col p-5 rounded-[26px] transition-all h-full min-h-[350px] select-none user-select-none overflow-hidden",
          "liquid-glass-card",
          isBulkMode && !bulkSelectionQty && "opacity-40 grayscale hover:opacity-100 hover:grayscale-0 cursor-pointer",
          isBulkMode && bulkSelectionQty > 0 && "ring-4 ring-orange-500 shadow-[0_0_24px_rgba(245,158,11,0.35)] cursor-pointer scale-[1.02] bg-orange-500/15",
          !isBulkMode && isCritical 
            ? "animate-breathe border-2 border-rose-500/60 bg-rose-500/10" 
            : !isBulkMode && isApproaching
              ? "bg-amber-500/10 border-2 border-amber-400/60 shadow-[0_0_20px_rgba(245,158,11,0.2)]"
              : "",
          !isBulkMode && isPressing && "scale-95 duration-[2s]" // smooth visual animation
        )}
      >
        <div className="absolute bottom-0 left-0 h-1 bg-slate-200/50 dark:bg-white/10 w-full z-0">
          <div 
            className={cn("h-full transition-all duration-1000", isCritical ? "bg-rose-500" : isApproaching ? "bg-amber-500" : "bg-blue-500")}
            style={{ width: `${percentage}%` }}
          />
        </div>

        {isPressing && (
           <div className="absolute inset-0 bg-blue-500/10 dark:bg-blue-400/15 pointer-events-none rounded-[26px] overflow-hidden z-20">
               <div className="absolute top-0 left-0 h-1 bg-blue-500 animate-fill-duration rounded-t-2xl"></div>
               <div className="absolute bottom-0 right-0 h-1 bg-blue-500 animate-fill-duration rounded-b-2xl" style={{ transform: 'rotate(180deg)' }}></div>
               <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full border-4 border-blue-500/20 border-t-blue-500/80 animate-spin"></div>
               </div>
           </div>
        )}

        {/* Top Section: Reference & Dedicated Right-Aligned Action Cluster */}
        <div className="w-full flex justify-between items-start mb-2 relative z-10 shrink-0">
          <div className="flex flex-col">
              <span className={cn(
                "text-sm font-black uppercase tracking-widest break-all liquid-glass-legible",
                isCritical ? "text-rose-600 dark:text-rose-400" : isApproaching ? "text-amber-700 dark:text-amber-500" : "text-slate-700 dark:text-slate-300"
              )}>
                {item.reference}
              </span>
          </div>
          <div className="flex items-center gap-1.5 -mr-1 -mt-1 shrink-0">
            {dragHandle}
            <button 
                onClick={(e) => { e.stopPropagation(); setShowHistory(true); }}
                className="p-1.5 rounded-xl liquid-glass-surface text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-300 transition-all active:scale-95"
                title="History"
            >
                <Clock className="h-4 w-4 liquid-glass-icon-drop" />
            </button>
            {canDelete && (
                <button 
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="p-1.5 rounded-xl liquid-glass-surface text-slate-500 dark:text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/15 transition-all active:scale-95"
                title="Delete Box"
                >
                <Trash2 className="h-4 w-4 liquid-glass-icon-drop" />
                </button>
            )}
          </div>
        </div>

        {/* Middle Section: Picture */}
        <div 
          className="absolute inset-x-0 inset-y-12 z-0 pointer-events-none flex items-center justify-center opacity-40 dark:opacity-50"
          style={{ 
            maskImage: 'linear-gradient(to bottom, transparent 0%, black 25%, black 75%, transparent 100%)', 
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 25%, black 75%, transparent 100%)' 
          }}
        >
           {item.pictureUrl && (
             <img 
               src={item.pictureUrl} 
               alt="" 
               loading="lazy"
               className="w-full h-full object-cover transition-all"
               style={{
                  objectPosition: picturePosition,
                  transform: `scale(${pictureScale})`
               }}
             />
           )}
        </div>
        
        {/* We need a spacer since we made the image absolute */}
        <div className="flex-1 min-h-[40px]"></div>

        {/* Lower Middle Section: Quantity & Limit */}
        <div className="flex justify-between items-end relative z-10 shrink-0">
          <div className="flex flex-col pointer-events-none justify-end">
            <span className={cn(
                "text-5xl font-mono leading-none tracking-tight mb-2",
                isCritical ? "text-rose-600 dark:text-rose-300" : isApproaching ? "text-amber-600 dark:text-amber-400" : "text-slate-800 dark:text-slate-200"
            )}>
              {item.quantity}
            </span>
            <span className={cn(
                "text-xs uppercase font-bold tracking-wider",
                isCritical ? "text-rose-500/80 dark:text-rose-400/80" : isApproaching ? "text-amber-600/80 dark:text-amber-500/80" : "text-slate-500"
            )}>
                Current Qty
            </span>
          </div>
          
          <div className="flex flex-col items-end pointer-events-none pb-0.5">
              {isCritical && (
                  <span className="px-2 py-0.5 bg-rose-500 text-[10px] font-bold text-white rounded uppercase mb-2 shadow-sm shadow-rose-900/50 ring-1 ring-rose-400">
                    Critical
                  </span>
              )}
              {isApproaching && (
                  <span className="px-2 py-0.5 bg-amber-500 text-[10px] font-bold text-white rounded uppercase mb-2 shadow-sm shadow-amber-900/50 ring-1 ring-amber-400">
                    Low Stock
                  </span>
              )}
              <span className={cn(
                  "text-sm font-bold tracking-wide",
                  isCritical ? "text-rose-700 dark:text-rose-400" : isApproaching ? "text-amber-700 dark:text-amber-300" : "text-slate-500 dark:text-slate-400"
              )}>
                  Limit: {item.securityLimit}
              </span>
          </div>
        </div>

        {/* Bottom Section: Controls */}
        {!isBulkMode && (
          <div className="w-full pt-4 mt-4 relative z-10 flex flex-col gap-2.5 border-t border-slate-200/50 dark:border-white/10 shrink-0">
            {canTake && (
              <button
                onClick={(e) => { e.stopPropagation(); onTake(); }}
                className={cn(
                  "w-full py-2.5 rounded-2xl flex items-center justify-center gap-2 font-bold text-sm tracking-wide transition-all active:scale-95 shadow-md",
                  isCritical 
                    ? "liquid-glass-btn-rose text-white" 
                    : isApproaching
                      ? "liquid-glass-btn-amber text-white"
                      : "liquid-glass-btn-blue text-white"
                )}
              >
                <PackageMinus className="h-4 w-4 liquid-glass-icon-drop" />
                <span className="liquid-glass-legible">Take From Kanban</span>
              </button>
            )}
            {canAdd && (
              <button
                onClick={(e) => { e.stopPropagation(); onAdd(); }}
                className="liquid-glass-btn-emerald w-full py-2.5 rounded-2xl flex items-center justify-center gap-2 font-bold text-sm tracking-wide text-white transition-all active:scale-95 shadow-md"
              >
                <PackagePlus className="h-4 w-4 liquid-glass-icon-drop" />
                <span className="liquid-glass-legible">Add Quantity</span>
              </button>
            )}
          </div>
        )}

        {isBulkMode && bulkSelectionQty !== undefined && bulkSelectionQty > 0 && (
          <div className="absolute top-4 right-4 bg-orange-500 text-white shadow-[0_0_18px_rgba(245,158,11,0.6)] rounded-full h-8 w-8 flex items-center justify-center font-black animate-in zoom-in text-sm z-30">
            {bulkSelectionQty}
          </div>
        )}
        
      </div>

      {/* History Modal local to box - Liquid Glass Modal */}
      {showHistory && (
        <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="liquid-glass-modal max-w-lg w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[82vh]">
             <div className="p-6 border-b border-slate-200/60 dark:border-white/10 flex justify-between items-center">
                <div>
                   <h2 className="text-xl font-bold text-slate-900 dark:text-white liquid-glass-legible">Box History</h2>
                   <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Box: {item.reference}</p>
                </div>
                <button 
                  onClick={() => setShowHistory(false)} 
                  className="px-3.5 py-1.5 liquid-glass-btn-secondary text-sm font-semibold rounded-xl"
                >
                  Close
                </button>
             </div>
             <div className="p-6 overflow-y-auto flex-1 space-y-4">
                {loadingHistory ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-3 text-slate-400">
                      <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs uppercase tracking-wider font-semibold">Loading history...</span>
                    </div>
                ) : history?.length === 0 ? (
                    <p className="text-center text-slate-500 uppercase tracking-widest text-xs font-bold py-8">No transactions recorded.</p>
                ) : (
                    <div className="space-y-3.5">
                        {history?.map(t => (
                            <div key={t.id} className="liquid-glass-surface rounded-2xl p-4 flex flex-col border border-white/20 dark:border-white/5">
                                <div className="flex justify-between items-start mb-3 border-b border-slate-200/50 dark:border-white/10 pb-3">
                                    <div className="flex items-center gap-2">
                                        <span className={cn(
                                            "flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase rounded-lg shadow-sm border",
                                            t.type === 'ADD' ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" : "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30"
                                        )}>
                                            {t.type === 'ADD' ? <ArrowDownToLine className="h-3 w-3" /> : <ArrowUpFromLine className="h-3 w-3" />}
                                            {t.type}
                                        </span>
                                        {t.type === 'REMOVE' && (
                                            <span className={cn(
                                                "flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold uppercase rounded-lg shadow-sm border",
                                                t.reason === 'Broken' ? "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30" : 
                                                t.reason === 'Lost' ? "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30" : 
                                                "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30"
                                            )}>
                                                {t.reason === 'Broken' ? <AlertTriangle className="h-3 w-3" /> : t.reason === 'Lost' ? <FileQuestion className="h-3 w-3" /> : <Activity className="h-3 w-3" />}
                                                {t.reason || 'Normal Use'}
                                            </span>
                                        )}
                                    </div>
                                    <span className="text-xs font-mono text-slate-500 dark:text-slate-400">{new Date(t.date).toLocaleString(undefined, {
                                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                                    })}</span>
                                </div>
                                <div className="flex justify-between items-center mt-1">
                                    <span className="text-sm text-slate-600 dark:text-slate-400 font-medium">Quantity: <strong className="text-xl text-slate-900 dark:text-white font-mono ml-1.5 px-2 py-0.5 rounded-lg liquid-glass-surface shadow-sm">{t.quantity}</strong></span>
                                    <div className="flex flex-col items-end">
                                      <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-0.5">Exec. User</span>
                                      <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t.username}</span>
                                    </div>
                                </div>
                                {t.poNumber && <div className="mt-3 liquid-glass-surface rounded-xl p-2.5 text-xs text-slate-500 font-mono tracking-widest flex justify-between items-center">
                                  <span>PO NUMBER</span>
                                  <span className="text-blue-600 dark:text-amber-400 font-bold">{t.poNumber}</span>
                                </div>}
                            </div>
                        ))}
                    </div>
                )}
             </div>
          </div>
        </div>
      )}
    </>
  );
}

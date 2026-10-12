import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { User, Transaction, KanbanItem, Role } from '../db';
import { 
  ArrowLeft, UserPlus, Search, Download, Trash2, Edit2, Settings, Move, Maximize, Minimize, 
  BarChart2, FileSpreadsheet, RefreshCw, CheckCircle2, FileDown, Calendar, HardDrive, 
  ShieldCheck, ChevronLeft, ChevronRight, X, TrendingUp, TrendingDown, Users, Award, 
  Activity, ArrowUpRight, BarChart3, LineChart, Trophy, Package, Sparkles, AlertTriangle
} from 'lucide-react';
import { cn } from '../lib/utils';
import { socket, subscribeToSocketState, getSocketState, fetchUsersList, fetchTransactionsPage, fetchDashboardWindowTransactions } from '../socket';
import { localDb, WeeklyArchiveRecord } from '../db/indexedDb';
import { syncAllWeeklyArchives, exportMasterExcel, downloadExcelBlob } from '../utils/excelArchiver';
import { migrateAllBase64ToStorage } from '../utils/imageStorage';
import { isSupabaseConfigured } from '../supabase';

export default function AdminView({ currentUser, onBack }: { currentUser: User, onBack: () => void }) {
  const [transactions, setTransactions] = useState<Transaction[]>(getSocketState().transactions);
  const [users, setUsers] = useState<User[]>(getSocketState().users);
  const [items, setItems] = useState<KanbanItem[]>(getSocketState().items);
  const [globalSettings, setGlobalSettings] = useState(getSocketState().settings || { picturePosition: '50% 50%', pictureScale: 1.0 });

  useEffect(() => {
    return subscribeToSocketState((state) => {
      setTransactions(state.transactions);
      setUsers(state.users);
      setItems(state.items);
      if (state.settings) setGlobalSettings(state.settings);
    });
  }, []);

  const [activeTab, setActiveTab] = useState<'dashboard' | 'transactions' | 'archives' | 'users' | 'global'>('dashboard');
  
  // Dashboard Interactive Controls State
  const [chartTimeframe, setChartTimeframe] = useState<'7d' | '14d' | '30d' | '90d' | 'all'>('30d');
  const [chartType, setChartType] = useState<'line' | 'bar'>('line');
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);
  const [withdrawersScope, setWithdrawersScope] = useState<'period' | 'all'>('period');

  // Weekly archives state
  const [weeklyArchives, setWeeklyArchives] = useState<WeeklyArchiveRecord[]>([]);
  const [isSyncingArchives, setIsSyncingArchives] = useState(false);

  // Pagination & Server-side Query for Transactions
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState<number | 'All'>(50);
  const [pagedTransactions, setPagedTransactions] = useState<Transaction[]>([]);
  const [totalTxCount, setTotalTxCount] = useState(0);
  const [loadingTransactions, setLoadingTransactions] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Dashboard Data Window State (Lazy, Egress-Optimized)
  const [dashboardTxs, setDashboardTxs] = useState<Transaction[]>([]);
  const [loadingDashboard, setLoadingDashboard] = useState(false);

  // Users Tab State (Loaded on demand only when tab opened)
  const [usersList, setUsersList] = useState<User[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  // Image Migration State
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationProgress, setMigrationProgress] = useState<{ current: number; total: number; message: string } | null>(null);
  const [migrationResult, setMigrationResult] = useState<{ migratedItems: number; migratedTransactions: number; migratedUsers: number; failed: number } | null>(null);

  const loadWeeklyArchives = async () => {
    try {
      const list = await localDb.weeklyArchives.toArray();
      list.sort((a, b) => b.id.localeCompare(a.id));
      setWeeklyArchives(list);
    } catch (e) {
      console.error("Failed to load weekly archives", e);
    }
  };

  useEffect(() => {
    if (activeTab === 'archives') {
      loadWeeklyArchives();
    }
  }, [activeTab]);

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      const list = await fetchUsersList();
      setUsersList(list);
    } catch (e) {
      console.error("Failed to load users", e);
    } finally {
      setLoadingUsers(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'users') {
      loadUsers();
    }
  }, [activeTab]);

  const loadTransactionsPage = async () => {
    setLoadingTransactions(true);
    try {
      const res = await fetchTransactionsPage({
        page: currentPage,
        pageSize: pageSize === 'All' ? 50 : pageSize,
        search: searchQuery
      });
      setPagedTransactions(res.transactions);
      setTotalTxCount(res.totalCount);
    } catch (e) {
      console.error('Error fetching transactions page:', e);
    } finally {
      setLoadingTransactions(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'transactions') {
      loadTransactionsPage();
    }
  }, [activeTab, currentPage, pageSize, searchQuery]);

  useEffect(() => {
    if (activeTab !== 'dashboard') return;

    let days = 30;
    if (chartTimeframe === '7d') days = 7;
    else if (chartTimeframe === '14d') days = 14;
    else if (chartTimeframe === '30d') days = 30;
    else if (chartTimeframe === '90d') days = 90;
    else if (chartTimeframe === 'all') days = 180;

    const startTimestamp = Date.now() - (days * 2) * 86400000;
    setLoadingDashboard(true);

    fetchDashboardWindowTransactions(startTimestamp, Date.now())
      .then(txs => {
        setDashboardTxs(txs);
      })
      .catch(err => {
        console.error('Failed to load dashboard data:', err);
      })
      .finally(() => {
        setLoadingDashboard(false);
      });
  }, [activeTab, chartTimeframe]);

  const handleRunMigration = async () => {
    if (!isSupabaseConfigured) {
      alert('Supabase is not configured. Migration requires a live Supabase connection.');
      return;
    }
    if (!confirm('This will scan all items, users, and transactions for base64 images and upload them to Supabase Storage. Proceed?')) {
      return;
    }
    setIsMigrating(true);
    setMigrationResult(null);
    try {
      const res = await migrateAllBase64ToStorage((info) => {
        setMigrationProgress(info);
      });
      setMigrationResult(res);
      // Refresh items
      const updatedItems = getSocketState().items;
      setItems([...updatedItems]);
      if (activeTab === 'users') loadUsers();
    } catch (e: any) {
      console.error('Migration failed:', e);
      alert(`Migration error: ${e?.message || String(e)}`);
    } finally {
      setIsMigrating(false);
    }
  };

  const handleSyncArchives = async () => {
    setIsSyncingArchives(true);
    try {
      const updated = await syncAllWeeklyArchives(transactions, items);
      setWeeklyArchives(updated);
    } catch (e) {
      console.error("Archive sync error:", e);
    } finally {
      setIsSyncingArchives(false);
    }
  };

  const handleDownloadArchive = (arch: WeeklyArchiveRecord) => {
    if (arch.fileBase64) {
      downloadExcelBlob(arch.fileBase64, arch.filename);
    } else {
      window.open(`/api/archives/${arch.id}/download`, '_blank');
    }
  };

  const handleExportMasterExcel = () => {
    exportMasterExcel(transactions, items);
  };
  
  // User Mgmt
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<Role>('Operator');
  
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editUserForm, setEditUserForm] = useState<Partial<User>>({});

  const defaultPos = globalSettings.picturePosition || '50% 50%';
  const [testPosX, setTestPosX] = useState(parseInt(defaultPos.split(' ')[0]) || 50);
  const [testPosY, setTestPosY] = useState(parseInt(defaultPos.split(' ')[1]) || 50);
  const [testScale, setTestScale] = useState(globalSettings.pictureScale || 1.0);

  const handleEditUserClick = (u: User) => {
    setEditingUser(u);
    setEditUserForm({
        username: u.username,
        password: '', // blank meaning no change
        role: u.role,
        theme: u.theme,
        settings: { ...u.settings }
    });
  };

  const handleSaveUserEdit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!editingUser) return;
      
      const payload: Partial<User> = {
          username: editUserForm.username,
          role: editUserForm.role,
          theme: editUserForm.theme,
          settings: editUserForm.settings
      };
      if (editUserForm.password && editUserForm.password.trim() !== '') {
          payload.password = editUserForm.password;
      }
      await socket.emit('updateUser', editingUser.id!, payload);
      setEditingUser(null);
      loadUsers();
  };
  
  const handleApplyGlobalSettings = () => {
    socket.emit('updateSettings', {
      picturePosition: `${testPosX}% ${testPosY}%`,
      pictureScale: testScale
    });
    alert('Global settings applied to all users.');
  };

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername || !newPassword) return;
    
    try {
      const newUser: User = {
        username: newUsername,
        password: newPassword,
        role: newRole,
        theme: 'dark',
        settings: {
          notificationMethod: 'none',
          alertThreshold: 150
        }
      };
      
      await socket.emit('addUser', newUser);
      await loadUsers();
      
      setNewUsername('');
      setNewPassword('');
      setNewRole('Operator');
    } catch (err) {
      console.error(err);
      alert("Error adding user.");
    }
  };

  const handleChangeRole = async (userId: string, newRole: Role) => {
    try {
      await socket.emit('updateUser', userId, { role: newRole });
      await loadUsers();
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, pageSize]);

  const totalPages = pageSize === 'All' ? 1 : Math.max(1, Math.ceil(totalTxCount / (typeof pageSize === 'number' ? pageSize : 50)));

  // -- ENHANCED DASHBOARD & ANALYTICS LOGIC (uses dashboardTxs window) --
  const dashboardAnalytics = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let daysCount = 30;
    if (chartTimeframe === '7d') daysCount = 7;
    else if (chartTimeframe === '14d') daysCount = 14;
    else if (chartTimeframe === '30d') daysCount = 30;
    else if (chartTimeframe === '90d') daysCount = 90;
    else if (chartTimeframe === 'all') {
      const earliestTx = dashboardTxs.reduce((min, t) => Math.min(min, t.date), Date.now());
      const diffDays = Math.ceil((Date.now() - earliestTx) / (1000 * 60 * 60 * 24));
      daysCount = Math.min(Math.max(diffDays, 7), 180);
    }

    const toDateKey = (d: Date | number) => {
      const date = typeof d === 'number' ? new Date(d) : d;
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    // Build timeline map for current period
    const dayMap = new Map<string, {
      dateKey: string;
      date: Date;
      label: string;
      fullDate: string;
      weekday: string;
      withdrawnQty: number;
      txCount: number;
      itemsMap: Record<string, number>;
      usersMap: Record<string, number>;
    }>();

    for (let i = daysCount - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const k = toDateKey(d);
      dayMap.set(k, {
        dateKey: k,
        date: d,
        label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
        fullDate: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
        weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
        withdrawnQty: 0,
        txCount: 0,
        itemsMap: {},
        usersMap: {}
      });
    }

    // Previous comparative period for trend calculation
    const prevPeriodStart = new Date(today);
    prevPeriodStart.setDate(prevPeriodStart.getDate() - (daysCount * 2));
    const prevPeriodEnd = new Date(today);
    prevPeriodEnd.setDate(prevPeriodEnd.getDate() - daysCount);
    let prevPeriodWithdrawn = 0;

    const removeTxs = dashboardTxs.filter(t => t.type === 'REMOVE');
    let periodWithdrawn = 0;
    let periodTxCount = 0;

    for (const t of removeTxs) {
      const tDate = new Date(t.date);
      const k = toDateKey(tDate);
      const qty = t.quantity || 1;

      if (dayMap.has(k)) {
        const item = dayMap.get(k)!;
        item.withdrawnQty += qty;
        item.txCount += 1;
        item.itemsMap[t.reference] = (item.itemsMap[t.reference] || 0) + qty;
        const u = t.username || 'Unknown';
        item.usersMap[u] = (item.usersMap[u] || 0) + qty;
        periodWithdrawn += qty;
        periodTxCount += 1;
      } else if (tDate >= prevPeriodStart && tDate < prevPeriodEnd) {
        prevPeriodWithdrawn += qty;
      }
    }

    const daysList = Array.from(dayMap.values()).map(d => {
      let topItem = '';
      let topItemQty = 0;
      for (const [ref, q] of Object.entries(d.itemsMap)) {
        if (q > topItemQty) {
          topItem = ref;
          topItemQty = q;
        }
      }
      return {
        ...d,
        topItem,
        topItemQty,
        activeUsersList: Object.keys(d.usersMap)
      };
    });

    const maxVal = Math.max(...daysList.map(d => d.withdrawnQty), 1);
    const avgDaily = (periodWithdrawn / daysList.length).toFixed(1);

    let peakDay = daysList[0];
    let activeDaysCount = 0;
    for (const d of daysList) {
      if (d.withdrawnQty > (peakDay?.withdrawnQty || 0)) {
        peakDay = d;
      }
      if (d.withdrawnQty > 0) activeDaysCount++;
    }

    let trendPercent = 0;
    if (prevPeriodWithdrawn > 0) {
      trendPercent = Math.round(((periodWithdrawn - prevPeriodWithdrawn) / prevPeriodWithdrawn) * 100);
    } else if (periodWithdrawn > 0) {
      trendPercent = 100;
    }

    // TOP WITHDRAWERS (Users Leaderboard)
    const withdrawerTxs = withdrawersScope === 'period'
      ? removeTxs.filter(t => dayMap.has(toDateKey(t.date)))
      : removeTxs;

    const userStatsMap: Record<string, {
      username: string;
      totalQty: number;
      txCount: number;
      itemsMap: Record<string, number>;
      lastWithdrawal: number;
    }> = {};

    for (const t of withdrawerTxs) {
      const u = t.username || 'Unknown';
      const qty = t.quantity || 1;
      if (!userStatsMap[u]) {
        userStatsMap[u] = {
          username: u,
          totalQty: 0,
          txCount: 0,
          itemsMap: {},
          lastWithdrawal: t.date
        };
      }
      userStatsMap[u].totalQty += qty;
      userStatsMap[u].txCount += 1;
      userStatsMap[u].itemsMap[t.reference] = (userStatsMap[u].itemsMap[t.reference] || 0) + qty;
      if (t.date > userStatsMap[u].lastWithdrawal) {
        userStatsMap[u].lastWithdrawal = t.date;
      }
    }

    const withdrawersScopeTotal = Object.values(userStatsMap).reduce((sum, u) => sum + u.totalQty, 0);

    const topWithdrawers = Object.values(userStatsMap)
      .sort((a, b) => b.totalQty - a.totalQty)
      .map(u => {
        const matchingUser = (usersList.length > 0 ? usersList : users).find(usr => usr.username.toLowerCase() === u.username.toLowerCase());
        let topItem = '';
        let topItemQty = 0;
        for (const [ref, q] of Object.entries(u.itemsMap)) {
          if (q > topItemQty) {
            topItem = ref;
            topItemQty = q;
          }
        }
        return {
          username: u.username,
          totalQty: u.totalQty,
          txCount: u.txCount,
          role: matchingUser?.role || 'Operator',
          avatarUrl: matchingUser?.avatarUrl,
          topItem,
          topItemQty,
          lastWithdrawal: u.lastWithdrawal,
          percentageOfTotal: withdrawersScopeTotal > 0 ? ((u.totalQty / withdrawersScopeTotal) * 100).toFixed(1) : '0'
        };
      });

    const maxWithdrawerQty = Math.max(...topWithdrawers.map(u => u.totalQty), 1);

    // TOP WITHDRAWN REFERENCES (Items)
    const itemMap: Record<string, { qty: number; txCount: number }> = {};
    for (const t of withdrawerTxs) {
      if (!itemMap[t.reference]) itemMap[t.reference] = { qty: 0, txCount: 0 };
      itemMap[t.reference].qty += (t.quantity || 1);
      itemMap[t.reference].txCount += 1;
    }

    const topItems = Object.entries(itemMap)
      .sort((a, b) => b[1].qty - a[1].qty)
      .slice(0, 10)
      .map(([ref, data]) => {
        const it = items.find(i => i.reference === ref);
        let status: 'healthy' | 'low' | 'critical' = 'healthy';
        if (it) {
          if (it.quantity <= it.securityLimit) status = 'critical';
          else if (it.quantity <= it.securityLimit * 1.5) status = 'low';
        }
        return {
          ref,
          qty: data.qty,
          txCount: data.txCount,
          currentStock: it?.quantity ?? 0,
          securityLimit: it?.securityLimit ?? 0,
          status,
          percentage: withdrawersScopeTotal > 0 ? ((data.qty / withdrawersScopeTotal) * 100).toFixed(1) : '0'
        };
      });

    const maxItemQty = Math.max(...topItems.map(i => i.qty), 1);

    return {
      daysList,
      periodTotal: periodWithdrawn,
      periodTxCount,
      avgDaily,
      peakDay,
      activeDaysCount,
      trendPercent,
      prevPeriodWithdrawn,
      maxVal,
      topWithdrawers,
      maxWithdrawerQty,
      topItems,
      maxItemQty,
      daysCount
    };
  }, [dashboardTxs, items, users, usersList, chartTimeframe, withdrawersScope]);

  const handleExportCSV = () => {
    let csvContent = "data:text/csv;charset=utf-8,";
    
    // Items CSV section
    csvContent += "=== ITEMS CONFIGURATION ===\r\n";
    csvContent += "ID,Reference,Quantity,Security Limit\r\n";
    items.forEach(item => {
      csvContent += `${item.id},${item.reference},${item.quantity},${item.securityLimit}\r\n`;
    });
    csvContent += "\r\n";

    // Transactions CSV section
    csvContent += "=== TRANSACTION HISTORY ===\r\n";
    csvContent += "Date,Type,Reason,Reference,Quantity,PO Number,User,Item ID\r\n";
    (pagedTransactions.length > 0 ? pagedTransactions : transactions).forEach(t => {
      const dateString = new Date(t.date).toLocaleString().replace(/,/g, '');
      csvContent += `${dateString},${t.type},${t.reason || 'Normal Use'},${t.reference},${t.quantity},${t.poNumber || 'N/A'},${t.username},${t.itemId}\r\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `admin_export_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const headerRef = React.useRef<HTMLElement>(null);
  const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!headerRef.current) return;
    const rect = headerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    headerRef.current.style.setProperty('--highlight-x', `${x}%`);
    headerRef.current.style.setProperty('--highlight-y', `${y}%`);
  };

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-[#080d1a] text-slate-900 dark:text-slate-200 p-4 sm:p-8 font-sans relative overflow-hidden">
      {/* Ambient background light orbs */}
      <div className="pointer-events-none absolute -top-40 -left-40 w-96 h-96 rounded-full bg-blue-500/10 dark:bg-blue-600/15 blur-3xl" />
      <div className="pointer-events-none absolute top-1/3 -right-40 w-96 h-96 rounded-full bg-indigo-500/10 dark:bg-indigo-600/15 blur-3xl" />

      <div className="max-w-7xl mx-auto flex flex-col min-h-[calc(100vh-4rem)] relative z-10">
        
        <header 
          ref={headerRef}
          onPointerMove={handlePointerMove}
          className="liquid-glass-command-bar p-4 sm:p-5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6 rounded-3xl"
        >
          <div className="flex items-center gap-4">
            <button 
              onClick={onBack}
              className="liquid-glass-btn-secondary p-2.5 rounded-2xl transition-all"
              title="Return to Rack"
            >
              <ArrowLeft className="h-5 w-5 text-slate-700 dark:text-slate-300 liquid-glass-icon-drop" />
            </button>
            <div className="flex flex-col">
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white liquid-glass-legible">System Admin</h1>
              <p className="text-slate-500 dark:text-slate-400 text-xs sm:text-sm">Full database & user management</p>
            </div>
          </div>

          <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
            <button
              onClick={handleExportMasterExcel}
              className="liquid-glass-btn-emerald px-4 py-2.5 rounded-2xl flex items-center gap-2 text-xs sm:text-sm font-bold shadow-lg"
              title="Download all transaction & inventory records as a formatted Excel (.xlsx) file"
            >
              <FileSpreadsheet className="h-4 w-4 liquid-glass-icon-drop" /> Export Excel (.xlsx)
            </button>
            <button
              onClick={handleExportCSV}
              className="liquid-glass-btn-secondary px-4 py-2.5 rounded-2xl flex items-center gap-2 text-xs sm:text-sm font-semibold"
            >
              <Download className="h-4 w-4 liquid-glass-icon-drop" /> Export CSV
            </button>
          </div>
        </header>

        <main className="flex-1 liquid-glass-card rounded-3xl overflow-hidden flex flex-col shadow-2xl">
          <div className="flex border-b border-slate-200/50 dark:border-white/10 px-6 pt-4 gap-6 liquid-glass-surface overflow-x-auto">
            {(currentUser.role === 'Admin' || currentUser.role === 'Manager') && (
              <button 
                onClick={() => setActiveTab('dashboard')}
                className={cn(
                  "pb-3 text-xs sm:text-sm font-bold uppercase tracking-wider relative flex items-center gap-2 whitespace-nowrap transition-colors",
                  activeTab === 'dashboard' ? "text-blue-600 dark:text-blue-400" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                )}
              >
                <BarChart2 className="h-4 w-4" />
                Dashboard
                {activeTab === 'dashboard' && (
                  <motion.div layoutId="adminActiveTabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400 rounded-t" />
                )}
              </button>
            )}

            <button 
              onClick={() => setActiveTab('transactions')}
              className={cn(
                "pb-3 text-xs sm:text-sm font-bold uppercase tracking-wider relative flex items-center gap-2 whitespace-nowrap transition-colors",
                activeTab === 'transactions' ? "text-blue-600 dark:text-blue-400" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              )}
            >
              Withdrawals & History
              {transactions.length > 0 && (
                <span className="text-[11px] bg-slate-200/80 dark:bg-white/10 text-slate-700 dark:text-slate-300 px-2 py-0.5 rounded-full font-mono font-bold">
                  {transactions.length}
                </span>
              )}
              {activeTab === 'transactions' && (
                <motion.div layoutId="adminActiveTabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400 rounded-t" />
              )}
            </button>

            <button 
              onClick={() => setActiveTab('archives')}
              className={cn(
                "pb-3 text-xs sm:text-sm font-bold uppercase tracking-wider relative flex items-center gap-2 whitespace-nowrap transition-colors",
                activeTab === 'archives' ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              )}
            >
              <FileSpreadsheet className="h-4 w-4" />
              Weekly Excel Archives
              {weeklyArchives.length > 0 && (
                <span className="text-[11px] bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold">
                  {weeklyArchives.length}
                </span>
              )}
              {activeTab === 'archives' && (
                <motion.div layoutId="adminActiveTabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-emerald-600 dark:bg-emerald-400 rounded-t" />
              )}
            </button>

            {currentUser.role === 'Admin' && (
              <button 
                onClick={() => setActiveTab('users')}
                className={cn(
                  "pb-3 text-xs sm:text-sm font-bold uppercase tracking-wider relative flex items-center gap-2 whitespace-nowrap transition-colors",
                  activeTab === 'users' ? "text-blue-600 dark:text-blue-400" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                )}
              >
                <UserPlus className="h-4 w-4" />
                User Management
                {activeTab === 'users' && (
                  <motion.div layoutId="adminActiveTabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400 rounded-t" />
                )}
              </button>
            )}
            
            {(currentUser.role === 'Admin' || currentUser.role === 'Manager') && (
              <button 
                onClick={() => setActiveTab('global')}
                className={cn(
                  "pb-3 text-xs sm:text-sm font-bold uppercase tracking-wider relative flex items-center gap-2 whitespace-nowrap transition-colors",
                  activeTab === 'global' ? "text-blue-600 dark:text-blue-400" : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                )}
              >
                <Settings className="h-4 w-4" />
                Global Settings
                {activeTab === 'global' && (
                  <motion.div layoutId="adminActiveTabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600 dark:bg-blue-400 rounded-t" />
                )}
              </button>
            )}
          </div>

          <div className="p-6 flex-1 overflow-auto overflow-x-hidden">
            <AnimatePresence mode="wait">
              {activeTab === 'dashboard' && (
                <motion.div 
                  key="dashboard"
                  initial={{ opacity: 0, x: 40 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -40 }}
                  transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
                  className="flex flex-col gap-6"
                >
                  {/* 1. COMPREHENSIVE DAILY WITHDRAWALS GRAPH */}
                  <motion.div 
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3, delay: 0.04, ease: [0.25, 1, 0.5, 1] }}
                    className="bg-white dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/80 rounded-2xl p-6 shadow-sm flex flex-col"
                  >
                  {/* Card Header & Controls */}
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-700/60">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-xl ring-1 ring-blue-500/20">
                        <Activity className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Daily Withdrawal Activity & Trends</h2>
                          <span className="text-xs bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full font-semibold">
                            Live Telemetry
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          Tracking checkout velocity, peak demand days, and stock depletion volume
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap self-start lg:self-auto">
                      {/* Timeframe selector */}
                      <div className="flex bg-slate-100 dark:bg-slate-900/90 p-1 rounded-xl border border-slate-200/80 dark:border-slate-700/80">
                        {(['7d', '14d', '30d', '90d', 'all'] as const).map((tf) => (
                          <button
                            key={tf}
                            onClick={() => {
                              setChartTimeframe(tf);
                              setHoveredPointIndex(null);
                            }}
                            className={cn(
                              "px-2.5 py-1 text-xs font-semibold rounded-lg transition-all",
                              chartTimeframe === tf 
                                ? "bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs" 
                                : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                            )}
                          >
                            {tf === '7d' ? '7 Days' : tf === '14d' ? '14 Days' : tf === '30d' ? '30 Days' : tf === '90d' ? '90 Days' : 'All'}
                          </button>
                        ))}
                      </div>

                      {/* Line vs Bar toggle */}
                      <div className="flex bg-slate-100 dark:bg-slate-900/90 p-1 rounded-xl border border-slate-200/80 dark:border-slate-700/80">
                        <button
                          onClick={() => setChartType('line')}
                          className={cn(
                            "p-1.5 rounded-lg text-xs font-medium transition-all",
                            chartType === 'line' 
                              ? "bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs" 
                              : "text-slate-500 hover:text-slate-900 dark:hover:text-white"
                          )}
                          title="Smooth Spline Trend"
                        >
                          <LineChart className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setChartType('bar')}
                          className={cn(
                            "p-1.5 rounded-lg text-xs font-medium transition-all",
                            chartType === 'bar' 
                              ? "bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-xs" 
                              : "text-slate-500 hover:text-slate-900 dark:hover:text-white"
                          )}
                          title="Daily Volume Bars"
                        >
                          <BarChart3 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Highlights Metric Strip */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 my-5">
                    <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200/70 dark:border-slate-800/80 rounded-xl p-3.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Total Units Withdrawn</span>
                      <div className="flex items-baseline gap-2 mt-1">
                        <span className="text-2xl font-black text-slate-900 dark:text-white font-mono">
                          {dashboardAnalytics.periodTotal.toLocaleString()}
                        </span>
                        <span className="text-xs text-slate-500 font-medium">units</span>
                      </div>
                      <div className="flex items-center gap-1 mt-1 text-xs">
                        {dashboardAnalytics.trendPercent > 0 ? (
                          <span className="text-rose-600 dark:text-rose-400 font-semibold flex items-center gap-0.5">
                            <TrendingUp className="h-3.5 w-3.5" /> +{dashboardAnalytics.trendPercent}% vs prev
                          </span>
                        ) : dashboardAnalytics.trendPercent < 0 ? (
                          <span className="text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-0.5">
                            <TrendingDown className="h-3.5 w-3.5" /> {dashboardAnalytics.trendPercent}% vs prev
                          </span>
                        ) : (
                          <span className="text-slate-400 font-medium">Stable vs prev</span>
                        )}
                      </div>
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200/70 dark:border-slate-800/80 rounded-xl p-3.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Daily Average</span>
                      <div className="flex items-baseline gap-1.5 mt-1">
                        <span className="text-2xl font-black text-slate-900 dark:text-white font-mono">
                          {dashboardAnalytics.avgDaily}
                        </span>
                        <span className="text-xs text-slate-500 font-medium">units / day</span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">Over {dashboardAnalytics.daysCount} tracked days</p>
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200/70 dark:border-slate-800/80 rounded-xl p-3.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Peak Demand Day</span>
                      <div className="flex items-baseline gap-1.5 mt-1">
                        <span className="text-2xl font-black text-blue-600 dark:text-blue-400 font-mono">
                          {dashboardAnalytics.peakDay?.withdrawnQty || 0}
                        </span>
                        <span className="text-xs text-slate-500 font-medium">units</span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate" title={dashboardAnalytics.peakDay?.fullDate}>
                        {dashboardAnalytics.peakDay ? `${dashboardAnalytics.peakDay.label} (${dashboardAnalytics.peakDay.weekday})` : 'None'}
                      </p>
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200/70 dark:border-slate-800/80 rounded-xl p-3.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Activity Frequency</span>
                      <div className="flex items-baseline gap-1.5 mt-1">
                        <span className="text-2xl font-black text-slate-900 dark:text-white font-mono">
                          {dashboardAnalytics.activeDaysCount}
                        </span>
                        <span className="text-xs text-slate-500 font-medium">/ {dashboardAnalytics.daysCount} active days</span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono">
                        {dashboardAnalytics.periodTxCount} withdrawal checkouts
                      </p>
                    </div>
                  </div>

                  {/* SVG Chart Container */}
                  {(() => {
                    const days = dashboardAnalytics.daysList;
                    if (days.length === 0) {
                      return (
                        <div className="h-60 flex items-center justify-center text-slate-400 text-sm">
                          No transaction telemetry recorded yet.
                        </div>
                      );
                    }

                    const chartPoints = days.map((d, i) => {
                      const x = 48 + (i / Math.max(days.length - 1, 1)) * 724;
                      const y = 184 - (d.withdrawnQty / Math.max(dashboardAnalytics.maxVal, 1)) * 158;
                      return { x, y, data: d, index: i };
                    });

                    // Catmull-Rom / cubic bezier generator
                    const getSmoothLinePath = (pts: Array<{ x: number; y: number }>) => {
                      if (pts.length === 0) return '';
                      if (pts.length === 1) return `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
                      let path = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
                      for (let i = 0; i < pts.length - 1; i++) {
                        const p0 = pts[Math.max(0, i - 1)];
                        const p1 = pts[i];
                        const p2 = pts[i + 1];
                        const p3 = pts[Math.min(pts.length - 1, i + 2)];
                        const cp1x = p1.x + (p2.x - p0.x) / 5;
                        const cp1y = p1.y + (p2.y - p0.y) / 5;
                        const cp2x = p2.x - (p3.x - p1.x) / 5;
                        const cp2y = p2.y - (p3.y - p1.y) / 5;
                        path += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
                      }
                      return path;
                    };

                    const smoothPath = getSmoothLinePath(chartPoints);
                    const areaPath = chartPoints.length > 0 
                      ? `${smoothPath} L ${chartPoints[chartPoints.length - 1].x.toFixed(1)},184 L ${chartPoints[0].x.toFixed(1)},184 Z`
                      : '';

                    const hoveredPoint = hoveredPointIndex !== null ? chartPoints[hoveredPointIndex] : null;

                    // Compute clean label indices for X axis
                    const labelStep = Math.max(1, Math.floor(chartPoints.length / 7));

                    return (
                      <div className="relative w-full h-[260px] select-none">
                        <svg viewBox="0 0 800 220" className="w-full h-full overflow-visible" preserveAspectRatio="none">
                          <defs>
                            <linearGradient id="withdrawalAreaGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.35" />
                              <stop offset="60%" stopColor="#3b82f6" stopOpacity="0.10" />
                              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
                            </linearGradient>
                            <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#60a5fa" />
                              <stop offset="100%" stopColor="#2563eb" />
                            </linearGradient>
                            <linearGradient id="barHoverGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#93c5fd" />
                              <stop offset="100%" stopColor="#3b82f6" />
                            </linearGradient>
                          </defs>

                          {/* Horizontal Grid lines and Y labels */}
                          <g className="opacity-40 dark:opacity-30">
                            <line x1="48" y1="26" x2="772" y2="26" stroke="currentColor" strokeDasharray="3 3" strokeWidth="1" className="text-slate-300 dark:text-slate-700" />
                            <line x1="48" y1="105" x2="772" y2="105" stroke="currentColor" strokeDasharray="3 3" strokeWidth="1" className="text-slate-300 dark:text-slate-700" />
                            <line x1="48" y1="184" x2="772" y2="184" stroke="currentColor" strokeWidth="1.5" className="text-slate-300 dark:text-slate-700" />
                          </g>

                          {/* Y-Axis Value Labels */}
                          <g className="text-[10px] font-mono fill-slate-400 select-none">
                            <text x="40" y="30" textAnchor="end">{dashboardAnalytics.maxVal}</text>
                            <text x="40" y="109" textAnchor="end">{Math.round(dashboardAnalytics.maxVal / 2)}</text>
                            <text x="40" y="188" textAnchor="end">0</text>
                          </g>

                          {/* Visual Chart Rendering based on ChartType */}
                          {chartType === 'line' ? (
                            <>
                              {/* Soft Gradient Area */}
                              <path 
                                d={areaPath} 
                                fill="url(#withdrawalAreaGradient)" 
                                className="transition-all duration-500 ease-out"
                              />

                              {/* Smooth Stroke Line */}
                              <path 
                                d={smoothPath} 
                                fill="none" 
                                stroke="#3b82f6" 
                                strokeWidth="3" 
                                strokeLinecap="round" 
                                strokeLinejoin="round" 
                                className="drop-shadow-[0_4px_10px_rgba(59,130,246,0.35)] transition-all duration-500 ease-out"
                              />

                              {/* Peak points or points on days with activity */}
                              {chartPoints.map((pt, i) => {
                                if (pt.data.withdrawnQty > 0) {
                                  const isPeak = pt.data.withdrawnQty === dashboardAnalytics.maxVal;
                                  return (
                                    <circle 
                                      key={i} 
                                      cx={pt.x} 
                                      cy={pt.y} 
                                      r={isPeak ? "4.5" : "3"} 
                                      className={cn(
                                        "transition-transform",
                                        isPeak ? "fill-blue-600 dark:fill-blue-400 stroke-white stroke-2" : "fill-blue-500"
                                      )}
                                    />
                                  );
                                }
                                return null;
                              })}
                            </>
                          ) : (
                            /* Bar Mode */
                            chartPoints.map((pt, i) => {
                              const barW = Math.max(Math.min(724 / chartPoints.length * 0.65, 28), 3.5);
                              const barH = Math.max(184 - pt.y, pt.data.withdrawnQty > 0 ? 3 : 0);
                              const isHovered = hoveredPointIndex === i;
                              return (
                                <rect
                                  key={i}
                                  x={pt.x - barW / 2}
                                  y={184 - barH}
                                  width={barW}
                                  height={barH}
                                  rx={barW > 6 ? 3 : 1}
                                  fill={isHovered ? "url(#barHoverGradient)" : "url(#barGradient)"}
                                  className="transition-all duration-200"
                                />
                              );
                            })
                          )}

                          {/* Interactive Guideline & Hover Indicator Point */}
                          {hoveredPoint && (
                            <g className="pointer-events-none transition-all">
                              <line 
                                x1={hoveredPoint.x} 
                                y1="24" 
                                x2={hoveredPoint.x} 
                                y2="184" 
                                stroke="#3b82f6" 
                                strokeWidth="1.5" 
                                strokeDasharray="3 3" 
                                opacity="0.8" 
                              />
                              <circle 
                                cx={hoveredPoint.x} 
                                cy={hoveredPoint.y} 
                                r="9" 
                                fill="#3b82f6" 
                                opacity="0.2" 
                                className="animate-ping" 
                              />
                              <circle 
                                cx={hoveredPoint.x} 
                                cy={hoveredPoint.y} 
                                r="5" 
                                fill="#2563eb" 
                                stroke="#ffffff" 
                                strokeWidth="2.5" 
                              />
                            </g>
                          )}

                          {/* Invisible Full-Height Hover Slices across all days */}
                          {chartPoints.map((pt, i) => {
                            const sliceWidth = 724 / chartPoints.length;
                            return (
                              <rect
                                key={i}
                                x={pt.x - sliceWidth / 2}
                                y="20"
                                width={sliceWidth}
                                height="170"
                                fill="transparent"
                                className="cursor-pointer"
                                onMouseEnter={() => setHoveredPointIndex(i)}
                              />
                            );
                          })}
                        </svg>

                        {/* Rich Floating Tooltip */}
                        {hoveredPoint && (
                          <div 
                            className="absolute pointer-events-none z-30 transition-all duration-75"
                            style={{
                              left: `${(hoveredPoint.x / 800) * 100}%`,
                              top: `${(Math.max(hoveredPoint.y, 45) / 220) * 100}%`,
                              transform: hoveredPoint.x > 620 
                                ? 'translate(-92%, -115%)' 
                                : hoveredPoint.x < 160 
                                ? 'translate(-8%, -115%)' 
                                : 'translate(-50%, -115%)'
                            }}
                          >
                            <div className="bg-slate-900/95 text-white dark:bg-slate-950/95 border border-slate-700/80 rounded-xl p-3 shadow-2xl backdrop-blur-md min-w-[200px] text-xs">
                              <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-slate-800">
                                <span className="font-semibold text-slate-300">{hoveredPoint.data.fullDate}</span>
                                <span className="font-mono text-[10px] text-blue-400 font-bold uppercase">{hoveredPoint.data.weekday}</span>
                              </div>
                              <div className="flex items-baseline justify-between mb-1">
                                <span className="text-slate-400">Total Checked Out:</span>
                                <span className="font-bold text-white font-mono text-sm">
                                  {hoveredPoint.data.withdrawnQty} units
                                </span>
                              </div>
                              <div className="flex items-baseline justify-between mb-1">
                                <span className="text-slate-400">Withdrawal Trips:</span>
                                <span className="font-medium text-slate-300 font-mono">
                                  {hoveredPoint.data.txCount} checkouts
                                </span>
                              </div>
                              {hoveredPoint.data.topItem && (
                                <div className="mt-1.5 pt-1.5 border-t border-slate-800/80 text-[11px]">
                                  <span className="text-slate-400">Primary Item: </span>
                                  <span className="font-semibold text-blue-300">{hoveredPoint.data.topItem}</span>
                                  <span className="text-slate-400 font-mono"> ({hoveredPoint.data.topItemQty}u)</span>
                                </div>
                              )}
                              {hoveredPoint.data.activeUsersList.length > 0 && (
                                <div className="mt-1 text-[11px] text-slate-400 truncate">
                                  <span>By: </span>
                                  <span className="text-slate-200">{hoveredPoint.data.activeUsersList.join(', ')}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* X-Axis Date Labels Bar */}
                        <div className="flex justify-between items-center px-12 pt-2 text-[11px] font-mono text-slate-500 dark:text-slate-400">
                          {chartPoints
                            .filter((_, i) => i === 0 || i === chartPoints.length - 1 || i % labelStep === 0)
                            .map((pt, idx) => (
                              <span key={idx} className="cursor-default hover:text-slate-900 dark:hover:text-white transition-colors">
                                {pt.data.label}
                              </span>
                            ))}
                        </div>
                      </div>
                    );
                  })()}
                </motion.div>

                {/* 2. TWO-COLUMN DASHBOARD GRID: TOP WITHDRAWERS & TOP WITHDRAWN REFERENCES */}
                <motion.div 
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: 0.08, ease: [0.25, 1, 0.5, 1] }}
                  className="grid grid-cols-1 lg:grid-cols-2 gap-6"
                >
                  {/* TOP WITHDRAWERS (USERS) PANEL */}
                  <div className="bg-white dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/80 rounded-2xl p-6 shadow-sm flex flex-col">
                    <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-700/60 mb-5">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 rounded-xl ring-1 ring-amber-500/20">
                          <Trophy className="h-5 w-5" />
                        </div>
                        <div>
                          <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                            Top Withdrawers
                          </h3>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            Ranking operators and warehouse staff by item checkout volume
                          </p>
                        </div>
                      </div>

                      <div className="flex bg-slate-100 dark:bg-slate-900/90 p-1 rounded-xl border border-slate-200/80 dark:border-slate-700/80">
                        <button
                          onClick={() => setWithdrawersScope('period')}
                          className={cn(
                            "px-2.5 py-1 text-xs font-semibold rounded-lg transition-all",
                            withdrawersScope === 'period'
                              ? "bg-white dark:bg-slate-800 text-amber-600 dark:text-amber-400 shadow-xs"
                              : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                          )}
                        >
                          Selected Range
                        </button>
                        <button
                          onClick={() => setWithdrawersScope('all')}
                          className={cn(
                            "px-2.5 py-1 text-xs font-semibold rounded-lg transition-all",
                            withdrawersScope === 'all'
                              ? "bg-white dark:bg-slate-800 text-amber-600 dark:text-amber-400 shadow-xs"
                              : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                          )}
                        >
                          All Time
                        </button>
                      </div>
                    </div>

                    <div className="flex-1 flex flex-col gap-3 min-h-[300px]">
                      {dashboardAnalytics.topWithdrawers.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8 text-center">
                          <Users className="h-10 w-10 text-slate-300 dark:text-slate-600 mb-2 stroke-1" />
                          <p className="text-sm font-medium">No withdrawal operations found in this timeframe.</p>
                          <p className="text-xs text-slate-400 mt-1">Take items from the Kanban Rack to see withdrawal analytics.</p>
                        </div>
                      ) : (
                        dashboardAnalytics.topWithdrawers.map((user, idx) => {
                          const isTop1 = idx === 0;
                          const isTop2 = idx === 1;
                          const isTop3 = idx === 2;

                          return (
                            <motion.div
                              key={user.username}
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ duration: 0.2, delay: idx * 0.04 }}
                              className="p-3.5 bg-slate-50/70 dark:bg-slate-900/40 hover:bg-slate-100/80 dark:hover:bg-slate-900/70 border border-slate-200/60 dark:border-slate-800/80 rounded-xl transition-all flex flex-col gap-2 group"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-center gap-3 min-w-0">
                                  {/* Rank Medal / Badge */}
                                  <div className={cn(
                                    "w-8 h-8 rounded-lg flex items-center justify-center font-bold text-xs shrink-0",
                                    isTop1 ? "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300 ring-1 ring-amber-400/40" :
                                    isTop2 ? "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300 ring-1 ring-slate-400/40" :
                                    isTop3 ? "bg-amber-950/20 text-amber-900 dark:bg-amber-950/60 dark:text-amber-400 ring-1 ring-amber-700/40" :
                                    "bg-slate-100 dark:bg-slate-800/80 text-slate-500 text-[11px]"
                                  )}>
                                    {isTop1 ? '🥇 #1' : isTop2 ? '🥈 #2' : isTop3 ? '🥉 #3' : `#${idx + 1}`}
                                  </div>

                                  {/* User Details */}
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="font-bold text-sm text-slate-900 dark:text-white truncate">
                                        {user.username}
                                      </span>
                                      <span className={cn(
                                        "text-[10px] px-1.5 py-0.2 rounded font-semibold uppercase tracking-wider",
                                        user.role === 'Admin' ? "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300" :
                                        user.role === 'Manager' ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" :
                                        "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                                      )}>
                                        {user.role}
                                      </span>
                                    </div>
                                    {user.topItem && (
                                      <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                                        Top Item: <span className="font-medium text-slate-700 dark:text-slate-300">{user.topItem}</span> ({user.topItemQty} units)
                                      </p>
                                    )}
                                  </div>
                                </div>

                                {/* Volume & Percentage */}
                                <div className="text-right shrink-0">
                                  <div className="flex items-baseline justify-end gap-1">
                                    <span className="text-base font-black text-slate-900 dark:text-white font-mono">
                                      {user.totalQty.toLocaleString()}
                                    </span>
                                    <span className="text-xs text-slate-500 font-medium">units</span>
                                  </div>
                                  <div className="text-[11px] text-slate-400 flex items-center justify-end gap-1.5 font-mono">
                                    <span>{user.txCount} trips</span>
                                    <span>•</span>
                                    <span className="text-blue-600 dark:text-blue-400 font-semibold">{user.percentageOfTotal}%</span>
                                  </div>
                                </div>
                              </div>

                              {/* Proportional Relative Progress Bar */}
                              <div className="w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                                <motion.div 
                                  initial={{ width: 0 }}
                                  animate={{ width: `${Math.max((user.totalQty / dashboardAnalytics.maxWithdrawerQty) * 100, 3)}%` }}
                                  transition={{ duration: 0.5, delay: idx * 0.05 }}
                                  className={cn(
                                    "h-full rounded-full transition-all",
                                    isTop1 ? "bg-gradient-to-r from-amber-500 to-amber-600" :
                                    isTop2 ? "bg-gradient-to-r from-blue-500 to-indigo-600" :
                                    "bg-gradient-to-r from-blue-400 to-blue-500"
                                  )}
                                />
                              </div>
                            </motion.div>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* TOP 10 WITHDRAWN REFERENCES PANEL */}
                  <div className="bg-white dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/80 rounded-2xl p-6 shadow-sm flex flex-col">
                    <div className="flex items-center justify-between pb-4 border-b border-slate-100 dark:border-slate-700/60 mb-5">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 rounded-xl ring-1 ring-blue-500/20">
                          <Package className="h-5 w-5" />
                        </div>
                        <div>
                          <h3 className="text-base font-bold text-slate-900 dark:text-white">
                            Top Withdrawn References
                          </h3>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            Highest turnover parts and current remaining rack inventory
                          </p>
                        </div>
                      </div>
                      <span className="text-xs font-mono font-semibold bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-lg text-slate-600 dark:text-slate-300">
                        Top {dashboardAnalytics.topItems.length}
                      </span>
                    </div>

                    <div className="flex-1 flex flex-col gap-3 min-h-[300px]">
                      {dashboardAnalytics.topItems.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8 text-center">
                          <Package className="h-10 w-10 text-slate-300 dark:text-slate-600 mb-2 stroke-1" />
                          <p className="text-sm font-medium">No reference item withdrawals recorded yet.</p>
                        </div>
                      ) : (
                        dashboardAnalytics.topItems.map((item, idx) => (
                          <motion.div
                            key={item.ref}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.2, delay: idx * 0.03 }}
                            className="p-3.5 bg-slate-50/70 dark:bg-slate-900/40 hover:bg-slate-100/80 dark:hover:bg-slate-900/70 border border-slate-200/60 dark:border-slate-800/80 rounded-xl transition-all flex flex-col gap-2 group"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <span className="w-5 text-right text-slate-400 font-mono text-xs font-bold shrink-0">
                                  {idx + 1}.
                                </span>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="font-bold text-sm text-slate-900 dark:text-white truncate font-mono" title={item.ref}>
                                      {item.ref}
                                    </span>
                                    {/* Stock Health Badge */}
                                    <span className={cn(
                                      "text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider shrink-0",
                                      item.status === 'critical' ? "bg-rose-100 text-rose-800 dark:bg-rose-950/70 dark:text-rose-300" :
                                      item.status === 'low' ? "bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300" :
                                      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300"
                                    )}>
                                      {item.status === 'critical' ? 'Critical Stock' :
                                       item.status === 'low' ? 'Low Stock' : 'Healthy'}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 font-mono">
                                    Current Stock: <strong className="text-slate-700 dark:text-slate-200">{item.currentStock}</strong> (Limit: {item.securityLimit})
                                  </p>
                                </div>
                              </div>

                              <div className="text-right shrink-0">
                                <div className="flex items-baseline justify-end gap-1">
                                  <span className="text-base font-black text-slate-900 dark:text-white font-mono">
                                    {item.qty.toLocaleString()}
                                  </span>
                                  <span className="text-xs text-slate-500 font-medium">taken</span>
                                </div>
                                <span className="text-[11px] text-slate-400 font-mono">
                                  {item.txCount} events
                                </span>
                              </div>
                            </div>

                            {/* Proportional Volume Bar */}
                            <div className="w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded-full overflow-hidden">
                              <motion.div 
                                initial={{ width: 0 }}
                                animate={{ width: `${Math.max((item.qty / dashboardAnalytics.maxItemQty) * 100, 3)}%` }}
                                transition={{ duration: 0.5, delay: idx * 0.04 }}
                                className={cn(
                                  "h-full rounded-full transition-all",
                                  item.status === 'critical' ? "bg-rose-500" :
                                  item.status === 'low' ? "bg-amber-500" :
                                  "bg-blue-500"
                                )}
                              />
                            </div>
                          </motion.div>
                        ))
                      )}
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}

            {activeTab === 'transactions' && (
              <motion.div 
                key="transactions"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
                className="flex flex-col h-full gap-4"
              >
                {/* Unlimited Records & Weekly Archive Status Banner */}
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: 0.04, ease: [0.25, 1, 0.5, 1] }}
                  className="liquid-glass-surface border border-emerald-500/30 rounded-2xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-lg"
                >
                  <div className="flex items-start gap-3">
                    <div className="p-2.5 bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 rounded-xl mt-0.5">
                      <ShieldCheck className="h-5 w-5 liquid-glass-icon-drop" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900 dark:text-white text-sm liquid-glass-legible">Unlimited Record Storage Engine</span>
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" /> Active
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                        <span className="font-semibold text-slate-900 dark:text-slate-200">{transactions.length.toLocaleString()} total records</span> stored permanently without row limits. All history is automatically saved to weekly Excel files.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 self-end md:self-auto flex-wrap">
                    <button
                      onClick={() => setActiveTab('archives')}
                      className="liquid-glass-btn-secondary px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-colors"
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-500" />
                      Weekly Archives ({weeklyArchives.length})
                    </button>
                    <button
                      onClick={handleExportMasterExcel}
                      className="liquid-glass-btn-emerald px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-md"
                    >
                      <FileDown className="h-3.5 w-3.5 liquid-glass-icon-drop" />
                      Download Master Excel
                    </button>
                  </div>
                </motion.div>

                {/* Search & Stats Bar */}
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: 0.07, ease: [0.25, 1, 0.5, 1] }}
                  className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3"
                >
                  <div className="relative flex-1">
                    <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 dark:text-slate-500" />
                    <input 
                      type="text" 
                      placeholder="Search by PO Number, Reference Name, User, or Reason..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-10 pr-8 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-2xl text-sm focus:ring-2 focus:ring-blue-500/50 outline-none transition-shadow"
                    />
                    {searchQuery && (
                      <button 
                        onClick={() => setSearchQuery('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-0.5"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-3 self-end sm:self-auto text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                    <span>
                      Showing <strong className="text-slate-900 dark:text-white">{totalTxCount === 0 ? 0 : (currentPage - 1) * (pageSize === 'All' ? totalTxCount : pageSize) + 1}</strong> to <strong className="text-slate-900 dark:text-white">{pageSize === 'All' ? totalTxCount : Math.min(currentPage * (typeof pageSize === 'number' ? pageSize : 50), totalTxCount)}</strong> of <strong className="text-slate-900 dark:text-white">{totalTxCount.toLocaleString()}</strong> records
                    </span>
                    <div className="flex items-center gap-1.5 liquid-glass-surface p-1 rounded-xl border border-slate-200/50 dark:border-white/10">
                      <span className="text-[11px] px-1 font-bold">Per page:</span>
                      {[25, 50, 100, 250, 'All'].map((sz) => (
                        <button
                          key={String(sz)}
                          onClick={() => setPageSize(sz as any)}
                          className={cn(
                            "px-2 py-0.5 rounded-lg text-xs font-bold transition-all",
                            pageSize === sz 
                              ? "bg-blue-600 text-white shadow-xs" 
                              : "text-slate-600 dark:text-slate-400 hover:bg-white/30 dark:hover:bg-white/10"
                          )}
                        >
                          {sz}
                        </button>
                      ))}
                    </div>
                  </div>
                </motion.div>

                {/* Table */}
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: 0.1, ease: [0.25, 1, 0.5, 1] }}
                  className="flex-1 overflow-y-auto"
                >
                  <div className="liquid-glass-card rounded-3xl overflow-hidden shadow-xl">
                    <table className="w-full text-left">
                      <thead className="liquid-glass-surface text-xs uppercase tracking-wider text-slate-500 font-bold border-b border-slate-200/50 dark:border-white/10">
                        <tr>
                          <th className="px-6 py-3.5">Date & Time</th>
                          <th className="px-6 py-3.5">Type</th>
                          <th className="px-6 py-3.5">Reason</th>
                          <th className="px-6 py-3.5">Reference</th>
                          <th className="px-6 py-3.5">Qty</th>
                          <th className="px-6 py-3.5">User</th>
                          <th className="px-6 py-3.5">PO / Delivery Ref</th>
                          <th className="px-6 py-3.5">Photo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/50 dark:divide-white/5 text-sm">
                        {loadingTransactions ? (
                          <tr>
                            <td colSpan={8} className="py-16 text-center">
                              <div className="flex flex-col items-center justify-center gap-3 text-slate-400">
                                <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                <span className="text-xs uppercase tracking-wider font-semibold">Loading records...</span>
                              </div>
                            </td>
                          </tr>
                        ) : pagedTransactions.map(t => (
                          <tr key={t.id} className="hover:bg-white/30 dark:hover:bg-white/5 transition-colors">
                            <td className="px-6 py-3.5 text-xs text-slate-600 dark:text-slate-400 whitespace-nowrap">
                              {new Date(t.date).toLocaleString()}
                            </td>
                            <td className="px-6 py-3.5">
                              <span className={cn(
                                "px-2 py-0.5 text-[10px] font-bold uppercase rounded-lg tracking-wider",
                                t.type === 'ADD' ? "bg-green-500/20 text-green-700 dark:text-green-300 border border-green-500/30" : "bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-500/30"
                              )}>
                                {t.type}
                              </span>
                            </td>
                            <td className="px-6 py-3.5 text-xs font-semibold">
                              <span className={cn(
                                "border rounded-lg px-2 py-0.5",
                                t.reason === 'Broken' ? 'bg-orange-50 text-orange-600 border-orange-200 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800' :
                                t.reason === 'Lost' ? 'bg-red-50 text-red-600 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800' :
                                'text-slate-500 border-transparent liquid-glass-surface dark:text-slate-400'
                              )}>
                                {t.reason || 'Normal Use'}
                              </span>
                            </td>
                            <td className="px-6 py-3.5 font-bold text-slate-900 dark:text-white">{t.reference}</td>
                            <td className="px-6 py-3.5 font-mono font-bold text-slate-700 dark:text-slate-200">{t.quantity}</td>
                            <td className="px-6 py-3.5 font-medium text-sm text-slate-700 dark:text-slate-300">{t.username}</td>
                            <td className="px-6 py-3.5 font-mono text-xs text-blue-600 dark:text-amber-400">{t.poNumber || '-'}</td>
                            <td className="px-6 py-3.5">
                              {t.pictureUrl ? (
                                <a href={t.pictureUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">View</a>
                              ) : (
                                <span className="text-xs text-slate-400">-</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!loadingTransactions && pagedTransactions.length === 0 && (
                      <div className="py-12 text-center text-slate-500">
                        No history records found matching your filter.
                      </div>
                    )}
                  </div>
                </motion.div>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between pt-2 border-t border-slate-200/50 dark:border-white/10">
                    <div className="text-xs text-slate-500">
                      Page <strong className="text-slate-900 dark:text-white">{currentPage}</strong> of <strong className="text-slate-900 dark:text-white">{totalPages}</strong>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="liquid-glass-btn-secondary px-3 py-1.5 text-xs font-semibold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 shadow-xs"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" /> Previous
                      </button>
                      
                      <div className="flex items-center gap-1">
                        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                          let pageNum = i + 1;
                          if (totalPages > 5) {
                            if (currentPage > 3 && currentPage < totalPages - 2) {
                              pageNum = currentPage - 2 + i;
                            } else if (currentPage >= totalPages - 2) {
                              pageNum = totalPages - 4 + i;
                            }
                          }
                          return (
                            <button
                              key={pageNum}
                              onClick={() => setCurrentPage(pageNum)}
                              className={cn(
                                "w-8 h-8 rounded-xl text-xs font-bold transition-all",
                                currentPage === pageNum
                                  ? "bg-blue-600 text-white shadow-md"
                                  : "text-slate-600 dark:text-slate-400 hover:bg-white/30 dark:hover:bg-white/10"
                              )}
                            >
                              {pageNum}
                            </button>
                          );
                        })}
                      </div>

                      <button
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        className="liquid-glass-btn-secondary px-3 py-1.5 text-xs font-semibold rounded-xl disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 shadow-xs"
                      >
                        Next <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </motion.div>
            )}

            {/* WEEKLY EXCEL ARCHIVES TAB */}
            {activeTab === 'archives' && (
              <motion.div 
                key="archives"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
                className="flex flex-col h-full gap-6"
              >
                {/* Engine Overview Card */}
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: 0.04, ease: [0.25, 1, 0.5, 1] }}
                  className="liquid-glass-card border border-emerald-500/30 rounded-3xl p-6 sm:p-8 shadow-2xl relative overflow-hidden"
                >
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                    <div className="space-y-2 max-w-2xl">
                      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full liquid-glass-surface border border-emerald-500/30 text-xs font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> Automated Weekly Excel Archiving Active
                      </div>
                      <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900 dark:text-white liquid-glass-legible">
                        Weekly Excel Archives & Unlimited Storage
                      </h2>
                      <p className="text-slate-600 dark:text-slate-300 text-sm leading-relaxed">
                        The app automatically compiles all transactions into weekly Excel workbooks (<code className="liquid-glass-surface border border-emerald-500/30 px-1.5 py-0.5 rounded text-emerald-700 dark:text-emerald-300 font-mono text-xs">.xlsx</code>). Every archive contains full transaction records, executive weekly summaries, reference volume analysis, and inventory snapshots. These files are permanently preserved and ready for download at any time, no matter what.
                      </p>
                    </div>

                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                      <button
                        onClick={handleSyncArchives}
                        disabled={isSyncingArchives}
                        className="liquid-glass-surface hover:bg-white/40 dark:hover:bg-white/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/30 rounded-2xl px-4 py-2.5 text-sm font-bold flex items-center justify-center gap-2 shadow-sm transition-all disabled:opacity-75"
                      >
                        <RefreshCw className={cn("h-4 w-4 text-emerald-600 dark:text-emerald-400", isSyncingArchives && "animate-spin")} />
                        {isSyncingArchives ? "Syncing Archives..." : "Sync & Save All Weeks Now"}
                      </button>

                      <button
                        onClick={handleExportMasterExcel}
                        className="liquid-glass-btn-emerald px-4 py-2.5 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 shadow-lg transition-all"
                      >
                        <FileDown className="h-4 w-4 liquid-glass-icon-drop" />
                        Download Master Excel (All History)
                      </button>
                    </div>
                  </div>

                  {/* Summary Metric Counters */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 pt-6 border-t border-slate-200/50 dark:border-white/10">
                    <div className="liquid-glass-surface rounded-2xl p-3.5 border border-emerald-500/20">
                      <div className="text-emerald-700 dark:text-emerald-300 text-xs font-bold uppercase tracking-wider">Total Weekly Archives</div>
                      <div className="text-2xl font-extrabold text-slate-900 dark:text-white mt-1 liquid-glass-legible">{weeklyArchives.length}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Ready to download</div>
                    </div>
                    <div className="liquid-glass-surface rounded-2xl p-3.5 border border-emerald-500/20">
                      <div className="text-emerald-700 dark:text-emerald-300 text-xs font-bold uppercase tracking-wider">Total Records Tracked</div>
                      <div className="text-2xl font-extrabold text-slate-900 dark:text-white mt-1 liquid-glass-legible">{transactions.length.toLocaleString()}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">No 1000 record limit</div>
                    </div>
                    <div className="liquid-glass-surface rounded-2xl p-3.5 border border-emerald-500/20">
                      <div className="text-emerald-700 dark:text-emerald-300 text-xs font-bold uppercase tracking-wider">Storage Redundancy</div>
                      <div className="text-lg font-bold text-slate-900 dark:text-white mt-1 liquid-glass-legible">Dual-Tier Storage</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">IndexedDB + Server</div>
                    </div>
                    <div className="liquid-glass-surface rounded-2xl p-3.5 border border-emerald-500/20">
                      <div className="text-emerald-700 dark:text-emerald-300 text-xs font-bold uppercase tracking-wider">Auto-Save Frequency</div>
                      <div className="text-lg font-bold text-slate-900 dark:text-white mt-1 liquid-glass-legible">Every Week & Realtime</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Always saved safely</div>
                    </div>
                  </div>
                </motion.div>

                {/* Archives List Section */}
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, delay: 0.08, ease: [0.25, 1, 0.5, 1] }}
                  className="flex-1 flex flex-col min-h-0"
                >
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-bold text-slate-900 dark:text-white text-base flex items-center gap-2 liquid-glass-legible">
                      <Calendar className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      Available Weekly Archives ({weeklyArchives.length})
                    </h3>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Files are permanently stored on device and ready for instant download
                    </span>
                  </div>

                  {weeklyArchives.length === 0 ? (
                    <div className="liquid-glass-card rounded-3xl p-12 text-center flex flex-col items-center justify-center gap-3 shadow-xl">
                      <div className="p-4 bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 rounded-2xl">
                        <FileSpreadsheet className="h-8 w-8 liquid-glass-icon-drop" />
                      </div>
                      <h4 className="font-bold text-slate-900 dark:text-white text-base liquid-glass-legible">No Weekly Archives Yet</h4>
                      <p className="text-slate-500 dark:text-slate-400 text-sm max-w-md">
                        Archives are automatically built every week. Click the button below to compile and save your weekly Excel files right now.
                      </p>
                      <button
                        onClick={handleSyncArchives}
                        disabled={isSyncingArchives}
                        className="mt-2 px-5 py-2.5 liquid-glass-btn-emerald rounded-2xl text-sm font-bold flex items-center gap-2 shadow-lg transition-all"
                      >
                        <RefreshCw className={cn("h-4 w-4", isSyncingArchives && "animate-spin")} />
                        Generate & Save Archives Now
                      </button>
                    </div>
                  ) : (
                    <div className="liquid-glass-card rounded-3xl overflow-hidden shadow-xl flex-1 overflow-y-auto">
                      <table className="w-full text-left">
                        <thead className="liquid-glass-surface text-xs uppercase tracking-wider text-slate-500 font-bold border-b border-slate-200/50 dark:border-white/10">
                          <tr>
                            <th className="px-6 py-4">Week & Period</th>
                            <th className="px-6 py-4">Date Range</th>
                            <th className="px-6 py-4">Status</th>
                            <th className="px-6 py-4">Activity Records</th>
                            <th className="px-6 py-4">File Details</th>
                            <th className="px-6 py-4 text-right">Download</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200/50 dark:divide-white/5 text-sm">
                          {weeklyArchives.map((arch) => (
                            <tr key={arch.id} className="hover:bg-white/30 dark:hover:bg-white/5 transition-colors">
                              <td className="px-6 py-4">
                                <div className="font-bold text-slate-900 dark:text-white flex items-center gap-2">
                                  <FileSpreadsheet className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                                  <span>{arch.year} — Week {arch.weekNumber}</span>
                                </div>
                                <div className="text-xs text-slate-500 font-mono mt-0.5">{arch.id}</div>
                              </td>

                              <td className="px-6 py-4 text-xs font-medium text-slate-700 dark:text-slate-300">
                                <span className="px-2.5 py-1 rounded-xl liquid-glass-surface border border-slate-200/50 dark:border-white/10 font-mono text-[11px] whitespace-nowrap">
                                  {arch.formattedRange}
                                </span>
                              </td>

                              <td className="px-6 py-4">
                                {arch.isCurrentWeek ? (
                                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-blue-500/20 border border-blue-500/30 text-blue-700 dark:text-blue-300">
                                    <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                                    Current Week (Live)
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/20 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300">
                                    <CheckCircle2 className="h-3 w-3" />
                                    Permanent Archive
                                  </span>
                                )}
                              </td>

                              <td className="px-6 py-4">
                                <div className="font-bold text-slate-900 dark:text-white text-sm">
                                  {arch.recordCount.toLocaleString()} <span className="text-xs font-normal text-slate-500">records</span>
                                </div>
                                <div className="flex items-center gap-2 text-[11px] mt-0.5">
                                  <span className="text-green-600 dark:text-green-400 font-semibold">+{arch.addCount} added</span>
                                  <span className="text-slate-300 dark:text-slate-600">•</span>
                                  <span className="text-rose-600 dark:text-rose-400 font-semibold">-{arch.removeCount} withdrawn</span>
                                </div>
                              </td>

                              <td className="px-6 py-4">
                                <div className="text-xs font-mono font-medium text-slate-800 dark:text-slate-200 truncate max-w-[200px]" title={arch.filename}>
                                  {arch.filename}
                                </div>
                                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                                  {(arch.fileSize / 1024).toFixed(1)} KB • {new Date(arch.generatedAt).toLocaleDateString()}
                                </div>
                              </td>

                              <td className="px-6 py-4 text-right">
                                <button
                                  onClick={() => handleDownloadArchive(arch)}
                                  className="liquid-glass-btn-emerald px-3.5 py-1.5 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 shadow-md"
                                  title={`Download ${arch.filename}`}
                                >
                                  <Download className="h-3.5 w-3.5 liquid-glass-icon-drop" />
                                  Download .xlsx
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </motion.div>
              </motion.div>
            )}

            {activeTab === 'users' && currentUser.role === 'Admin' && (
              <motion.div 
                key="users"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
                className="grid grid-cols-1 lg:grid-cols-3 gap-8"
              >
                <div className="lg:col-span-1 liquid-glass-card rounded-3xl p-6 shadow-xl h-fit">
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2 liquid-glass-legible">
                    <UserPlus className="h-5 w-5 text-blue-500 dark:text-blue-400" />
                    Create User
                  </h3>
                  <form onSubmit={handleAddUser} className="space-y-4">
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Username</label>
                      <input 
                        type="text" required value={newUsername} onChange={e => setNewUsername(e.target.value)}
                        className="w-full px-3.5 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 rounded-xl text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500/50 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Password</label>
                      <input 
                        type="password" required value={newPassword} onChange={e => setNewPassword(e.target.value)}
                        className="w-full px-3.5 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 rounded-xl text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500/50 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Role</label>
                      <select 
                        value={newRole} onChange={e => setNewRole(e.target.value as any)}
                        className="w-full px-3.5 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 rounded-xl text-slate-900 dark:text-white text-sm outline-none"
                      >
                        <option value="Overview">Overview (View Only)</option>
                        <option value="Operator">Operator (View & Take Items)</option>
                        <option value="Warehouse">Warehouse (Add Quantities)</option>
                        <option value="Manager">Manager (Edit Limits)</option>
                        <option value="Admin">Admin (Full Access)</option>
                      </select>
                    </div>
                    <button type="submit" className="liquid-glass-btn-blue w-full py-2.5 rounded-xl font-bold transition-all mt-4 text-sm shadow-lg">
                      Create User
                    </button>
                  </form>
                </div>

                <div className="lg:col-span-2 flex flex-col gap-4">
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white liquid-glass-legible">System Users</h3>
                  <div className="liquid-glass-card rounded-3xl overflow-hidden shadow-xl">
                    <table className="w-full text-left">
                      <thead className="liquid-glass-surface text-xs uppercase tracking-wider text-slate-500 font-bold border-b border-slate-200/50 dark:border-white/10">
                        <tr>
                          <th className="px-6 py-4">Username</th>
                          <th className="px-6 py-4">Role</th>
                          <th className="px-6 py-4 w-12 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/50 dark:divide-white/5">
                        {loadingUsers ? (
                          <tr>
                            <td colSpan={3} className="py-12 text-center">
                              <div className="flex flex-col items-center justify-center gap-3 text-slate-400">
                                <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                <span className="text-xs uppercase tracking-wider font-semibold">Loading users...</span>
                              </div>
                            </td>
                          </tr>
                        ) : (usersList.length > 0 ? usersList : users).map(u => (
                          <tr key={u.id} className="hover:bg-white/30 dark:hover:bg-white/5 transition-colors">
                            <td className="px-6 py-4 font-medium text-slate-900 dark:text-slate-200">{u.username}</td>
                            <td className="px-6 py-4">
                              <select 
                                value={u.role}
                                onChange={(e) => handleChangeRole(u.id!, e.target.value as Role)}
                                className={cn(
                                  "px-2.5 py-1 text-xs font-bold uppercase rounded-xl border outline-none liquid-glass-surface transition-all",
                                  u.role === 'Admin' ? "text-amber-700 dark:text-amber-400 border-amber-500/30" : 
                                  u.role === 'Manager' ? "text-blue-700 dark:text-blue-400 border-blue-500/30" : 
                                  u.role === 'Warehouse' ? "text-purple-700 dark:text-purple-400 border-purple-500/30" : 
                                  u.role === 'Overview' ? "text-slate-600 dark:text-slate-400 border-slate-500/30" :
                                  "text-green-700 dark:text-green-300 border-green-500/30"
                                )}
                              >
                                <option value="Overview">Overview</option>
                                <option value="Operator">Operator</option>
                                <option value="Warehouse">Warehouse</option>
                                <option value="Manager">Manager</option>
                                <option value="Admin">Admin</option>
                              </select>
                            </td>
                            <td className="px-6 py-4 text-right">
                                <div className="flex items-center justify-end gap-1.5">
                                    <button 
                                        onClick={() => handleEditUserClick(u)}
                                        className="liquid-glass-btn-secondary p-2 rounded-xl text-slate-500 hover:text-blue-600 dark:text-slate-400 dark:hover:text-blue-400 transition-colors"
                                        title="Edit User"
                                    >
                                        <Edit2 className="h-4 w-4" />
                                    </button>
                                    {u.id !== currentUser.id && (
                                        <button 
                                            onClick={async () => {
                                                if (confirm(`Are you sure you want to delete user ${u.username}?`)) {
                                                    await socket.emit('deleteUser', u.id);
                                                    await loadUsers();
                                                }
                                            }}
                                            className="liquid-glass-btn-danger p-2 rounded-xl transition-colors"
                                            title="Delete User"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    )}
                                </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'global' && (currentUser.role === 'Admin' || currentUser.role === 'Manager') && (
              <motion.div 
                key="global"
                initial={{ opacity: 0, x: 40 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -40 }}
                transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
                className="max-w-2xl mx-auto flex flex-col gap-8 h-full"
              >
                <div className="liquid-glass-card rounded-3xl p-6 sm:p-8 shadow-xl">
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2 flex items-center gap-2 liquid-glass-legible">
                    <Settings className="h-5 w-5 text-blue-500" />
                    Global Kanban Box Appearance
                  </h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
                    Configure how images are displayed inside Kanban boxes. This setting applies to all users.
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div>
                      <div className="mb-4">
                        <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Vertical Position (Y%)</label>
                        <input 
                          type="range" min="0" max="100" value={testPosY} 
                          onChange={(e) => setTestPosY(Number(e.target.value))}
                          className="w-full accent-blue-600"
                        />
                        <div className="flex justify-between text-xs text-slate-400 font-mono mt-1">
                          <span>Top (0%)</span><span>{testPosY}%</span><span>Bottom (100%)</span>
                        </div>
                      </div>

                      <div className="mb-4">
                        <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Horizontal Position (X%)</label>
                        <input 
                          type="range" min="0" max="100" value={testPosX} 
                          onChange={(e) => setTestPosX(Number(e.target.value))}
                          className="w-full accent-blue-600"
                        />
                        <div className="flex justify-between text-xs text-slate-400 font-mono mt-1">
                          <span>Left (0%)</span><span>{testPosX}%</span><span>Right (100%)</span>
                        </div>
                      </div>

                      <div className="mb-6">
                        <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Scale (Zoom)</label>
                        <input 
                          type="range" min="0.5" max="3" step="0.1" value={testScale} 
                          onChange={(e) => setTestScale(Number(e.target.value))}
                          className="w-full accent-blue-600"
                        />
                        <div className="flex justify-between text-xs text-slate-400 font-mono mt-1">
                          <span>0.5x</span><span>{testScale}x</span><span>3.0x</span>
                        </div>
                      </div>

                      <button 
                        onClick={handleApplyGlobalSettings}
                        className="liquid-glass-btn-blue w-full py-2.5 rounded-xl font-bold transition-all text-sm shadow-lg"
                      >
                        Apply to All Users
                      </button>
                    </div>

                    <div className="flex flex-col items-center">
                      <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2 self-start">Preview</label>
                      <div className="w-full aspect-[4/5] liquid-glass-surface rounded-2xl relative overflow-hidden border border-slate-200/50 dark:border-white/10 flex items-center justify-center p-4">
                        {/* Mock Box gradient */}
                        <div className="absolute inset-0 liquid-glass-surface rounded-xl m-4 border border-slate-200/50 dark:border-white/10 pointer-events-none flex flex-col justify-between p-4">
                           <div className="flex justify-between items-start z-10 relative">
                             <div className="w-16 h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse"></div>
                             <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 animate-pulse"></div>
                           </div>
                           <div className="flex justify-between items-end z-10 relative">
                             <div className="w-12 h-8 bg-slate-200 dark:bg-slate-700 rounded animate-pulse"></div>
                             <div className="w-16 h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse"></div>
                           </div>
                        </div>

                        {/* Middle section for picture preview exactly like KanbanBox */}
                        <div 
                          className="absolute inset-x-0 inset-y-12 z-0 pointer-events-none flex items-center justify-center opacity-40 dark:opacity-50"
                          style={{ 
                            maskImage: 'linear-gradient(to bottom, transparent 0%, black 25%, black 75%, transparent 100%)', 
                            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 25%, black 75%, transparent 100%)' 
                          }}
                        >
                           <img 
                             src="https://images.unsplash.com/photo-1587202372775-e229f172b9d7?auto=format&fit=crop&q=80&w=400&h=400" 
                             alt="preview" 
                             loading="lazy"
                             className="w-full h-full object-cover transition-all"
                             style={{
                                objectPosition: `${testPosX}% ${testPosY}%`,
                                transform: `scale(${testScale})`
                             }}
                           />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* ONE-TIME SUPABASE STORAGE MIGRATION CARD */}
                <div className="liquid-glass-card rounded-3xl p-6 sm:p-8 shadow-xl">
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div>
                      <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-1.5 flex items-center gap-2.5 liquid-glass-legible">
                        <HardDrive className="h-5 w-5 text-indigo-500" />
                        One-Time Image Storage Migration
                      </h3>
                      <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
                        Converts all embedded <code className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 font-mono text-xs">data:image/...</code> base64 
                        strings in Items, Users, and Transactions into optimized cloud files stored in Supabase Storage bucket 
                        <code className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 font-mono text-xs ml-1">kanban-images</code>.
                      </p>
                    </div>
                  </div>

                  <div className="p-4 rounded-2xl liquid-glass-surface border border-slate-200/50 dark:border-white/10 mb-6 text-xs text-slate-600 dark:text-slate-300 space-y-2">
                    <div className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                      <Sparkles className="w-4 h-4 text-amber-500" />
                      Egress & Storage Optimization Protection:
                    </div>
                    <ul className="list-disc list-inside space-y-1 text-slate-500 dark:text-slate-400 pl-1">
                      <li>Reduces item row size from ~1 MB down to ~150 bytes.</li>
                      <li>Prevents Supabase Realtime from broadcasting massive payloads on every quantity update.</li>
                      <li>Resizes photos to compact specifications (items ≤ 600px, proofs ≤ 800px, avatars ≤ 128px, 0.8 quality).</li>
                    </ul>
                  </div>

                  {migrationProgress && (
                    <div className="mb-6 p-4 rounded-2xl liquid-glass-surface border border-blue-500/30">
                      <div className="flex justify-between text-xs font-bold text-slate-800 dark:text-slate-200 mb-2">
                        <span>{migrationProgress.message}</span>
                        {migrationProgress.total > 0 && (
                          <span className="font-mono">{migrationProgress.current} / {migrationProgress.total}</span>
                        )}
                      </div>
                      {migrationProgress.total > 0 && (
                        <div className="w-full bg-slate-200 dark:bg-slate-700 h-2 rounded-full overflow-hidden">
                          <div 
                            className="bg-blue-600 h-full transition-all duration-300 rounded-full"
                            style={{ width: `${Math.round((migrationProgress.current / migrationProgress.total) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {migrationResult && (
                    <div className="mb-6 p-4 rounded-2xl liquid-glass-surface border border-emerald-500/30 text-emerald-800 dark:text-emerald-300 text-xs">
                      <div className="font-bold flex items-center gap-2 mb-1 text-sm">
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                        Migration Complete!
                      </div>
                      <p>
                        Successfully uploaded & updated {migrationResult.migratedItems} item photos, {migrationResult.migratedUsers} avatars, and {migrationResult.migratedTransactions} proof photos.
                        {migrationResult.failed > 0 && ` (${migrationResult.failed} failed)`}
                      </p>
                    </div>
                  )}

                  <button
                    onClick={handleRunMigration}
                    disabled={isMigrating}
                    className="liquid-glass-btn-blue px-6 py-3 rounded-xl font-bold text-sm shadow-lg flex items-center gap-2.5 disabled:opacity-50 cursor-pointer"
                  >
                    {isMigrating ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Migrating Images to Cloud Storage...</span>
                      </>
                    ) : (
                      <>
                        <HardDrive className="w-4 h-4 liquid-glass-icon-drop" />
                        <span>Migrate All Base64 Images to Supabase Storage</span>
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}
            </AnimatePresence>

            {/* Bottom Credits Footer - Only seen when scrolled all the way to the bottom */}
            <footer className="mt-20 pt-8 pb-12 border-t border-slate-200/50 dark:border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-bold text-slate-700 dark:text-slate-200">System Kanban Rack</span>
                <span className="text-slate-300 dark:text-slate-700">•</span>
                <span className="font-semibold text-blue-600 dark:text-blue-400">September 2026 Update</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span>Created by</span>
                <span className="font-bold text-slate-800 dark:text-slate-100">Abdellah boukhare</span>
              </div>
            </footer>
          </div>
        </main>
      </div>

      {editingUser && (
          <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
              <div className="liquid-glass-modal w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                  <div className="p-6 border-b border-slate-200/50 dark:border-white/10 flex justify-between items-center liquid-glass-surface">
                      <h3 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2 liquid-glass-legible">
                          <Edit2 className="h-5 w-5 text-blue-500" />
                          Edit User
                      </h3>
                      <button onClick={() => setEditingUser(null)} className="liquid-glass-btn-secondary p-1.5 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                          <X className="h-4 w-4" />
                      </button>
                  </div>
                  <div className="p-6">
                      <form onSubmit={handleSaveUserEdit} className="space-y-4">
                          <div>
                              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Username</label>
                              <input 
                                  type="text" required value={editUserForm.username || ''} onChange={e => setEditUserForm({...editUserForm, username: e.target.value})}
                                  className="w-full px-3.5 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 rounded-xl text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500/50 outline-none"
                              />
                          </div>
                          <div>
                              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Password <span className="text-slate-400 font-normal lowercase tracking-normal">(leave blank to keep unchanged)</span></label>
                              <input 
                                  type="password" value={editUserForm.password || ''} onChange={e => setEditUserForm({...editUserForm, password: e.target.value})}
                                  className="w-full px-3.5 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 rounded-xl text-slate-900 dark:text-white text-sm focus:ring-2 focus:ring-blue-500/50 outline-none"
                                  placeholder="New password..."
                              />
                          </div>
                          <div>
                              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Role</label>
                              <select 
                                  value={editUserForm.role || 'Operator'} onChange={e => setEditUserForm({...editUserForm, role: e.target.value as Role})}
                                  className="w-full px-3.5 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 rounded-xl text-slate-900 dark:text-white text-sm outline-none"
                              >
                                  <option value="Overview">Overview (View Only)</option>
                                  <option value="Operator">Operator (View & Take Items)</option>
                                  <option value="Warehouse">Warehouse (Add Quantities)</option>
                                  <option value="Manager">Manager (Edit Limits)</option>
                                  <option value="Admin">Admin (Full Access)</option>
                              </select>
                          </div>
                          <div className="flex gap-4">
                              <div className="flex-1">
                                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Theme</label>
                                  <select 
                                      value={editUserForm.theme || 'dark'} onChange={e => setEditUserForm({...editUserForm, theme: e.target.value as 'light'|'dark'})}
                                      className="w-full px-3.5 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 rounded-xl text-slate-900 dark:text-white text-sm outline-none"
                                  >
                                      <option value="light">Light</option>
                                      <option value="dark">Dark</option>
                                  </select>
                              </div>
                          </div>
                          <div className="pt-2">
                              <h4 className="text-sm font-bold text-slate-900 dark:text-white mb-3 liquid-glass-legible">User Settings</h4>
                              <div className="grid grid-cols-2 gap-4">
                                  <div>
                                       <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Notification Method</label>
                                       <select 
                                           value={editUserForm.settings?.notificationMethod || 'none'} 
                                           onChange={e => setEditUserForm({
                                               ...editUserForm, 
                                               settings: { ...editUserForm.settings!, notificationMethod: e.target.value as any }
                                           })}
                                           className="w-full px-3.5 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 rounded-xl text-slate-900 dark:text-white text-sm outline-none"
                                       >
                                           <option value="none">None</option>
                                           <option value="email">Email</option>
                                           <option value="push">Push Notification</option>
                                       </select>
                                  </div>
                                  <div>
                                       <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">Alert Threshold (%)</label>
                                       <input 
                                           type="number" min="1" max="1000"
                                           value={editUserForm.settings?.alertThreshold || 150} 
                                           onChange={e => setEditUserForm({
                                               ...editUserForm, 
                                               settings: { ...editUserForm.settings!, alertThreshold: Number(e.target.value) }
                                           })}
                                           className="w-full px-3.5 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 rounded-xl text-slate-900 dark:text-white text-sm outline-none"
                                       />
                                  </div>
                              </div>
                          </div>
                          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200/50 dark:border-white/10 mt-6">
                              <button type="button" onClick={() => setEditingUser(null)} className="liquid-glass-btn-secondary px-4 py-2 text-sm font-semibold rounded-xl">
                                  Cancel
                              </button>
                              <button type="submit" className="liquid-glass-btn-blue px-5 py-2 text-sm font-bold rounded-xl shadow-lg">
                                  Save Changes
                              </button>
                          </div>
                      </form>
                  </div>
              </div>
          </div>
      )}
    </div>
  );
}

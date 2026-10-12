import React, { useState, useRef } from 'react';
import { Package, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { User } from '../db';
import { loginUser, dataReady } from '../socket';
import { isSupabaseConfigured } from '../supabase';

export default function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    cardRef.current.style.setProperty('--highlight-x', `${x}%`);
    cardRef.current.style.setProperty('--highlight-y', `${y}%`);
  };
  
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    
    try {
      if (dataReady) await dataReady;
      const user = await loginUser(username, password);
      
      if (user) {
        onLogin(user);
      } else {
        setError('Invalid username or password.');
      }
    } catch (err: any) {
      setError(`Network error during login. Check your configuration or network. Details: ${err?.message || String(err)}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-[#080d1a] text-slate-900 dark:text-slate-200 flex items-center justify-center p-4 font-sans relative overflow-hidden">
      {/* Dynamic ambient backdrop lights */}
      <div className="pointer-events-none absolute -top-40 -left-40 w-96 h-96 rounded-full bg-blue-500/10 dark:bg-blue-600/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 w-96 h-96 rounded-full bg-indigo-500/10 dark:bg-indigo-600/15 blur-3xl" />

      <motion.div 
        ref={cardRef}
        onPointerMove={handlePointerMove}
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -12 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="w-full max-w-md liquid-glass-modal p-8 sm:p-10 shadow-2xl relative overflow-hidden"
      >
        <div className="flex flex-col items-center mb-8">
          <motion.div 
            whileHover={{ scale: 1.08, rotate: 3 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 17 }}
            className="h-16 w-16 liquid-glass-surface border border-blue-500/30 text-blue-600 dark:text-blue-400 rounded-2xl flex items-center justify-center mb-4 shadow-lg cursor-default"
          >
            <Package className="h-8 w-8 liquid-glass-icon-drop" />
          </motion.div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white mb-1.5 liquid-glass-legible">Kanban System</h1>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 dark:text-slate-400">Warehouse Floor 04 • Operator Access</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <AnimatePresence>
            {!isSupabaseConfigured && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="liquid-glass-surface border border-amber-500/30 text-amber-800 dark:text-amber-300 p-3.5 rounded-2xl text-xs flex items-start gap-2.5 overflow-hidden"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
                <div>
                  <strong className="font-bold">Offline Local Mode Active</strong>
                  <p className="mt-0.5 text-amber-700 dark:text-amber-300/90 leading-relaxed">Using persistent client-side database storage. To connect external cloud database, provide credentials in settings.</p>
                </div>
              </motion.div>
            )}

            {error && (
              <motion.div 
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="liquid-glass-surface border border-rose-500/40 text-rose-700 dark:text-rose-300 px-4 py-3 rounded-2xl text-xs font-medium"
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>
          
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1.5" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              type="text"
              required
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full px-4 py-3 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl text-sm focus:ring-2 focus:ring-blue-500/50 outline-none transition-all"
              placeholder="e.g. admin"
            />
          </div>
          
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1.5" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-3 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl text-sm focus:ring-2 focus:ring-blue-500/50 outline-none transition-all font-mono"
              placeholder="••••••"
            />
          </div>

          <motion.button
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            type="submit"
            disabled={loading}
            className="w-full mt-2 py-3.5 liquid-glass-btn-blue text-white font-bold text-sm rounded-xl shadow-lg flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Signing In...</span>
              </>
            ) : (
              <span>Sign In to Rack</span>
            )}
          </motion.button>
        </form>
      </motion.div>
    </div>
  );
}

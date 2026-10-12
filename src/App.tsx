import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import Login from './components/Login';
import KanbanRack from './components/KanbanRack';
import AdminView from './components/AdminView';
import { User } from './db';
import { socket } from './socket';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentView, setCurrentView] = useState<'Kanban' | 'Admin'>('Kanban');
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
     const cached = localStorage.getItem('kanbanUser');
     if (cached) {
        setCurrentUser(JSON.parse(cached));
     }
     setIsInitializing(false);
  }, []);

  useEffect(() => {
    if (currentUser?.theme === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }
  }, [currentUser?.theme]);

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-[#0f172a] text-slate-900 dark:text-slate-200 flex items-center justify-center font-sans tracking-widest text-sm uppercase">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs font-semibold text-slate-400">Loading Kanban System...</span>
        </div>
      </div>
    );
  }

  const handleLogin = (user: User) => {
    setCurrentUser(user);
    localStorage.setItem('kanbanUser', JSON.stringify(user));
  };

  if (!currentUser) {
    return (
      <AnimatePresence mode="wait">
        <Login onLogin={handleLogin} />
      </AnimatePresence>
    );
  }

  const handleLogout = () => {
    setCurrentUser(null);
    localStorage.removeItem('kanbanUser');
    setCurrentView('Kanban');
  };

  const handleUpdateUser = async (updates: Partial<User>) => {
    if (!currentUser.id) return;
    
    socket.emit('updateUser', currentUser.id, updates);
    const updatedUser = { ...currentUser, ...updates };
    setCurrentUser(updatedUser);
    localStorage.setItem('kanbanUser', JSON.stringify(updatedUser));
  };

  return (
    <div className="relative min-h-screen bg-slate-50 dark:bg-[#0b0f19] text-slate-900 dark:text-slate-100 font-sans selection:bg-blue-500/20 overflow-x-hidden">
      {/* Subtle Ambient Radial Lighting */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden opacity-40 dark:opacity-25">
        <div className="absolute -top-[15%] left-1/2 -translate-x-1/2 w-[900px] h-[500px] bg-gradient-to-b from-blue-500/15 via-indigo-500/10 to-transparent blur-3xl rounded-full" />
        <div className="absolute top-[40%] -left-[10%] w-[500px] h-[500px] bg-gradient-to-tr from-sky-400/10 to-transparent blur-3xl rounded-full" />
        <div className="absolute bottom-0 right-[5%] w-[500px] h-[500px] bg-gradient-to-tl from-purple-500/10 to-transparent blur-3xl rounded-full" />
      </div>

      <div className="relative z-10">
        <AnimatePresence mode="wait">
          {currentView === 'Admin' ? (
            <motion.div
              key="admin"
              initial={{ opacity: 0, x: 36 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -36 }}
              transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
              className="min-h-screen"
            >
              <AdminView 
                currentUser={currentUser} 
                onBack={() => setCurrentView('Kanban')} 
              />
            </motion.div>
          ) : (
            <motion.div
              key="kanban"
              initial={{ opacity: 0, x: -36 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 36 }}
              transition={{ duration: 0.28, ease: [0.25, 1, 0.5, 1] }}
              className="min-h-screen p-3 sm:p-5 lg:p-6 font-sans"
            >
              <div className="max-w-[1720px] w-full mx-auto flex flex-col min-h-[calc(100vh-3rem)]">
                <KanbanRack 
                  currentUser={currentUser} 
                  onAdminAccess={() => setCurrentView('Admin')}
                  onLogout={handleLogout}
                  onUpdateUser={handleUpdateUser}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

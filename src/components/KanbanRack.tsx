import React, { useState, useEffect, useRef } from 'react';
import { Package, Plus, Search, ArrowUp, ArrowDown, LogOut, Settings, Database, Camera, Trash2, GripVertical, PackageMinus, X } from 'lucide-react';
import { User, KanbanItem, Transaction } from '../db';
import { cn } from '../lib/utils';
import KanbanBox from './KanbanBox';
import CropModal from './CropModal';
import { socket, subscribeToSocketState, getSocketState } from '../socket';
import { processItemImage, processProofImage, processAvatarImage } from '../utils/imageStorage';
import { DndContext, closestCenter, DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

function SortableKanbanBox({ item, ...props }: any) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="relative group/sortable h-full">
      <KanbanBox 
        item={item} 
        {...props} 
        dragHandle={props.canSort ? (
          <button 
            {...attributes} 
            {...listeners} 
            className="p-1.5 rounded-xl liquid-glass-surface text-slate-500 dark:text-slate-400 hover:text-white hover:bg-blue-600/80 cursor-grab active:cursor-grabbing transition-all active:scale-95"
            title="Drag to reorder"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <GripVertical className="h-4 w-4 liquid-glass-icon-drop" />
          </button>
        ) : null}
      />
    </div>
  );
}

export default function KanbanRack({ currentUser, onAdminAccess, onLogout, onUpdateUser }: { currentUser: User, onAdminAccess: () => void, onLogout: () => void, onUpdateUser: (u: Partial<User>) => void }) {
  const [items, setItems] = useState<KanbanItem[]>(getSocketState().items);
  
  const [globalSettings, setGlobalSettings] = useState(getSocketState().settings || { picturePosition: '50% 50%', pictureScale: 1.0 });

  useEffect(() => {
    return subscribeToSocketState((state) => {
      setItems(state.items);
      if (state.settings) setGlobalSettings(state.settings);
    });
  }, []);

  // State
  const [searchQuery, setSearchQuery] = useState('');
  const [sortConfig, setSortConfig] = useState<{key: keyof KanbanItem | 'custom', dir: 'asc'|'desc'}>({ key: 'custom', dir: 'asc' });

  // Add Item Modal
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newReference, setNewReference] = useState('');
  const [newQuantity, setNewQuantity] = useState<number>(0);
  const [newSecurityLimit, setNewSecurityLimit] = useState<number>(0);
  const [newPicture, setNewPicture] = useState<string | null>(null);

  // Take From Kanban Modal
  const [takeModalOpen, setTakeModalOpen] = useState(false);
  const [addStockModalOpen, setAddStockModalOpen] = useState(false);
  const [activeItem, setActiveItem] = useState<KanbanItem | null>(null);
  const [takeQty, setTakeQty] = useState<number>(1);
  const [addQty, setAddQty] = useState<number>(1);
  const [takePo, setTakePo] = useState('');
  const [takePic, setTakePic] = useState<string | null>(null);
  const [takeReason, setTakeReason] = useState<'Normal Use' | 'Broken' | 'Lost'>('Normal Use');

  // Edit Item Modal (from long press)
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<KanbanItem | null>(null);

  // User Settings Modal
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsForm, setSettingsForm] = useState(currentUser.settings || { notificationMethod: 'none', alertThreshold: 150 });
  
  // Delete Item Modal
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<string | null>(null);

  // Bulk Take Features
  const [bulkModeActive, setBulkModeActive] = useState(false);
  const [bulkTakePoModalOpen, setBulkTakePoModalOpen] = useState(false);
  const [bulkTakePo, setBulkTakePo] = useState('');
  const [bulkTakeSelections, setBulkTakeSelections] = useState<Record<string, number>>({});
  const [bulkTakeItemSelectId, setBulkTakeItemSelectId] = useState<string | null>(null);
  const [bulkQtyInput, setBulkQtyInput] = useState<number>(1);
  const [bulkTakeFinalModalOpen, setBulkTakeFinalModalOpen] = useState(false);

  // Undo Toast System
  const [pendingUndo, setPendingUndo] = useState<{
    itemId: string;
    reference: string;
    type: 'ADD' | 'REMOVE';
    quantityDelta: number;
    previousQty: number;
    transactionId: string;
    timeout: NodeJS.Timeout;
  } | null>(null);
  
  // Crop Modal state

  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null);
  const [cropTarget, setCropTarget] = useState<'new' | 'edit' | 'take' | null>(null);

  // Computed Items
  const filteredAndSortedItems = React.useMemo(() => {
    return [...items]
      .filter(it => it.reference.toLowerCase().includes(searchQuery.toLowerCase()))
      .sort((a, b) => {
          if (sortConfig.key === 'custom') {
              return ((a.order || 0) - (b.order || 0)) * (sortConfig.dir === 'asc' ? 1 : -1);
          }
          let valA = a[sortConfig.key as keyof KanbanItem];
          let valB = b[sortConfig.key as keyof KanbanItem];
          if (typeof valA === 'string' && typeof valB === 'string') {
              return sortConfig.dir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
          }
          if (typeof valA === 'number' && typeof valB === 'number') {
              return sortConfig.dir === 'asc' ? valA - valB : valB - valA;
          }
          return 0;
      });
  }, [items, searchQuery, sortConfig.key, sortConfig.dir]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
        if (searchQuery || sortConfig.key !== 'custom') return;

        const oldIndex = filteredAndSortedItems.findIndex((i) => i.id === active.id);
        const newIndex = filteredAndSortedItems.findIndex((i) => i.id === over.id);
        const reordered = arrayMove(filteredAndSortedItems, oldIndex, newIndex);
        
        // compute new orders
        const updates: { id: string, order: number }[] = [];
        const newItems = [...items];
        reordered.forEach((item: KanbanItem, index) => {
           if (item.order !== index) {
               if (item.id) updates.push({ id: item.id, order: index });
               const itemIdx = newItems.findIndex(i => i.id === item.id);
               if (itemIdx > -1) {
                   newItems[itemIdx] = { ...newItems[itemIdx], order: index };
               }
           }
        });
        if (updates.length > 0) socket.emit('reorderItems', updates);
        setItems(newItems);
    }
  };

  const handleAddItem = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanRef = newReference.trim();
    if (!cleanRef) return;
    try {
      const existingItem = items.find(i => i.reference.toLowerCase() === cleanRef.toLowerCase());

      if (existingItem) {
        socket.emit('updateItem', existingItem.id, { quantity: existingItem.quantity + newQuantity });
        if (newQuantity > 0) {
          socket.emit('addTransaction', {
            itemId: existingItem.id!,
            reference: existingItem.reference,
            type: 'ADD',
            quantity: newQuantity,
            date: Date.now(),
            userId: currentUser.id!,
            username: currentUser.username
          });
        }
      } else {
        const generatedId = crypto.randomUUID();
        const newItem = {
          id: generatedId,
          reference: cleanRef,
          quantity: newQuantity,
          securityLimit: newSecurityLimit,
          pictureUrl: newPicture || undefined,
        };
        
        socket.emit('addItem', newItem);
        
        if (newQuantity > 0) {
          socket.emit('addTransaction', {
            itemId: generatedId,
            reference: cleanRef,
            type: 'ADD',
            quantity: newQuantity,
            date: Date.now(),
            userId: currentUser.id!,
            username: currentUser.username
          });
        }
      }
      
      setNewReference(''); setNewQuantity(0); setNewSecurityLimit(0); setNewPicture(null);
      setIsAddModalOpen(false);
    } catch (e) {
      console.error(e);
    }
  };

  const handleEditItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editItem || !editItem.reference.trim() || !editItem.id) return;
    try {
      socket.emit('updateItem', editItem.id, {
        reference: editItem.reference,
        quantity: editItem.quantity,
        securityLimit: editItem.securityLimit,
        pictureUrl: editItem.pictureUrl
      });
      setEditModalOpen(false);
      setEditItem(null);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteItem = (id: string) => {
    setItemToDelete(id);
    setDeleteModalOpen(true);
  };

  const confirmDelete = () => {
    if (itemToDelete) {
      try {
        socket.emit('deleteItem', itemToDelete);
      } catch (e) {
        console.error(e);
      }
      setDeleteModalOpen(false);
      setItemToDelete(null);
    }
  };

  const openTakeModal = (item: KanbanItem) => {
    setActiveItem(item);
    setTakeQty(1);
    setTakePo('');
    setTakePic(null);
    setTakeReason('Normal Use');
    setTakeModalOpen(true);
  };

  const handleBulkTakeSubmit = async () => {
    try {
      // Validate everything first
      for (const [id, qty] of Object.entries(bulkTakeSelections) as [string, number][]) {
        if (qty <= 0) continue;
        const targetItem = items.find(i => i.id === id);
        if (!targetItem) continue;
        
        if (qty > targetItem.quantity) {
          alert(`Cannot remove ${qty} from ${targetItem.reference} (only ${targetItem.quantity} available). Check skipped for this item, execution stopped.`);
          return;
        }
      }

      // If all valid, process batch payloads
      const itemUpdates: { id: string; quantity: number }[] = [];
      const transactions: Transaction[] = [];

      for (const [id, qty] of Object.entries(bulkTakeSelections) as [string, number][]) {
        if (qty <= 0) continue;
        const targetItem = items.find(i => i.id === id)!;
        const newQty = targetItem.quantity - qty;

        // Email Mock
        if (targetItem.quantity > targetItem.securityLimit && newQty <= targetItem.securityLimit) {
            if (currentUser.settings?.notificationMethod === 'email' && currentUser.settings?.email) {
                setTimeout(() => {
                    alert(`📧 Mock Email Sent to ${currentUser.settings?.email}:\n\nAlert! Reference ${targetItem.reference} has dropped to critical limit (${newQty} remaining). Please restock.`);
                }, 500);
            }
        }

        itemUpdates.push({ id: targetItem.id!, quantity: newQty });
        transactions.push({
          id: crypto.randomUUID(),
          itemId: targetItem.id!,
          reference: targetItem.reference,
          type: 'REMOVE',
          reason: 'Normal Use',
          quantity: qty,
          poNumber: bulkTakePo,
          pictureUrl: undefined,
          date: Date.now(),
          userId: currentUser.id!,
          username: currentUser.username
        });
      }

      // Single batched socket emit instead of 2N sequential roundtrips!
      socket.emit('batchTake', { itemUpdates, transactions });

      setBulkTakeFinalModalOpen(false);
      setBulkModeActive(false);
      setBulkTakePo('');
      setBulkTakeSelections({});
    } catch (err) {
      console.error(err);
    }
  };

  const handleTakeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeItem || !activeItem.id) return;
    if (takeReason === 'Normal Use' && !/^\d{12}$/.test(takePo)) {
      alert("PO must be exactly 12 numbers.");
      return;
    }
    if (takeQty > activeItem.quantity) {
      alert("Cannot remove more than the current quantity.");
      return;
    }

    try {
      const newQty = activeItem.quantity - takeQty;

      // Email Mock
      if (activeItem.quantity > activeItem.securityLimit && newQty <= activeItem.securityLimit) {
          if (currentUser.settings?.notificationMethod === 'email' && currentUser.settings?.email) {
              setTimeout(() => {
                  alert(`📧 Mock Email Sent to ${currentUser.settings?.email}:\n\nAlert! Reference ${activeItem.reference} has dropped to critical limit (${newQty} remaining). Please restock.`);
              }, 500);
          }
      }

      socket.emit('updateItem', activeItem.id, { quantity: newQty });
      const transactionId = crypto.randomUUID();
      socket.emit('addTransaction', {
        id: transactionId,
        itemId: activeItem.id,
        reference: activeItem.reference,
        type: 'REMOVE',
        reason: takeReason,
        quantity: takeQty,
        poNumber: takePo,
        pictureUrl: takePic,
        date: Date.now(),
        userId: currentUser.id!,
        username: currentUser.username
      });
      setTakeModalOpen(false);

      if (pendingUndo) clearTimeout(pendingUndo.timeout);
      setPendingUndo({
        itemId: activeItem.id,
        reference: activeItem.reference,
        type: 'REMOVE',
        quantityDelta: takeQty,
        previousQty: activeItem.quantity,
        transactionId,
        timeout: setTimeout(() => setPendingUndo(null), 5000),
      });

      setActiveItem(null);
    } catch (err) {
      console.error(err);
    }
  };

  const openAddStockModal = (item: KanbanItem) => {
      setActiveItem(item);
      setAddQty(1);
      setAddStockModalOpen(true);
  };

  const handleAddStockSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!activeItem || !activeItem.id) return;
      try {
          socket.emit('updateItem', activeItem.id, { quantity: activeItem.quantity + addQty });
          const transactionId = crypto.randomUUID();
          socket.emit('addTransaction', {
              id: transactionId,
              itemId: activeItem.id!,
              reference: activeItem.reference,
              type: 'ADD',
              quantity: addQty,
              date: Date.now(),
              userId: currentUser.id!,
              username: currentUser.username
          });
          setAddStockModalOpen(false);

          if (pendingUndo) clearTimeout(pendingUndo.timeout);
          setPendingUndo({
              itemId: activeItem.id,
              reference: activeItem.reference,
              type: 'ADD',
              quantityDelta: addQty,
              previousQty: activeItem.quantity,
              transactionId,
              timeout: setTimeout(() => setPendingUndo(null), 5000),
          });

          setActiveItem(null);
      } catch (err) {
          console.error(err);
      }
  };

  const handleUndo = () => {
      if (!pendingUndo) return;
      clearTimeout(pendingUndo.timeout);
      
      socket.emit('updateItem', pendingUndo.itemId, { quantity: pendingUndo.previousQty });
      socket.emit('deleteTransaction', pendingUndo.transactionId);
      
      setPendingUndo(null);
  };

  const startImageCrop = (e: React.ChangeEvent<HTMLInputElement>, target: 'new' | 'edit' | 'take') => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        setCropImageSrc(reader.result?.toString() || null);
        setCropTarget(target);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleCropComplete = async (croppedBase64: string) => {
    try {
      if (cropTarget === 'new') {
        const url = await processItemImage(croppedBase64);
        setNewPicture(url);
      } else if (cropTarget === 'edit' && editItem) {
        const url = await processItemImage(croppedBase64);
        setEditItem({ ...editItem, pictureUrl: url });
      } else if (cropTarget === 'take') {
        const url = await processProofImage(croppedBase64);
        setTakePic(url);
      }
    } catch (e) {
      console.error('Failed to process image:', e);
      if (cropTarget === 'new') setNewPicture(croppedBase64);
      else if (cropTarget === 'edit' && editItem) setEditItem({ ...editItem, pictureUrl: croppedBase64 });
      else if (cropTarget === 'take') setTakePic(croppedBase64);
    }
    setCropImageSrc(null);
    setCropTarget(null);
  };

  const handleCropCancel = () => {
    setCropImageSrc(null);
    setCropTarget(null);
  };

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateUser({ settings: settingsForm });
    setIsSettingsOpen(false);
  };

  const canManage = currentUser.role === 'Admin' || currentUser.role === 'Manager';
  const canAddBox = currentUser.role === 'Admin' || currentUser.role === 'Manager';
  const canDelete = currentUser.role === 'Admin' || currentUser.role === 'Manager';
  const canTakeItems = currentUser.role === 'Admin' || currentUser.role === 'Manager' || currentUser.role === 'Operator';
  const canAddQuantity = currentUser.role === 'Admin' || currentUser.role === 'Manager' || currentUser.role === 'Warehouse';
  const threshold = currentUser.settings?.alertThreshold || 150;

  const roleGradients: Record<string, string> = {
    Admin: 'from-amber-400 to-orange-600',
    Manager: 'from-blue-400 to-indigo-600',
    Warehouse: 'from-purple-400 to-pink-600',
    Operator: 'from-emerald-400 to-cyan-600',
    Overview: 'from-slate-400 to-slate-600',
  };
  const profileGradient = roleGradients[currentUser.role] || roleGradients.Operator;

  const headerRef = useRef<HTMLElement>(null);

  const handleHeaderPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!headerRef.current) return;
    const rect = headerRef.current.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 100);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 100);
    headerRef.current.style.setProperty('--highlight-x', `${x}%`);
    headerRef.current.style.setProperty('--highlight-y', `${y}%`);
  };

  return (
    <div className="flex flex-col min-h-full bg-transparent text-slate-900 dark:text-slate-100">
      {/* Symmetrical Apple Liquid Glass Command Bar (iOS 26 / iPadOS 26) */}
      <header 
        ref={headerRef}
        onPointerMove={handleHeaderPointerMove}
        className="liquid-glass-nav mb-8 p-4 sm:px-7 sm:py-4 transition-all select-none w-full"
        style={{ '--highlight-x': '50%', '--highlight-y': '50%' } as React.CSSProperties}
      >
        {/* Physically Simulated Dynamic Specular Refraction Layer */}
        <div className="liquid-glass-refraction" />

        <div className="relative z-10 flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4 lg:gap-8">
          
          {/* LEFT: Branding, Title & Liquid Glass Update Pill */}
          <div className="flex items-center gap-4 shrink-0">
            <div className="relative flex items-center justify-center w-11 h-11 rounded-[20px] bg-gradient-to-br from-blue-600 via-indigo-600 to-purple-700 text-white shadow-lg shadow-indigo-500/25 ring-1 ring-white/30 active:scale-95 transition-transform duration-200 shrink-0">
              <Package className="h-6 w-6 liquid-glass-icon-drop" />
              <span className="absolute -top-1 -right-1 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500 border-2 border-white dark:border-slate-900 shadow-sm"></span>
              </span>
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-xl sm:text-2xl font-black tracking-tight text-slate-900 dark:text-white cursor-default liquid-glass-legible">
                  System Kanban Rack
                </h1>
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold liquid-glass-surface text-blue-600 dark:text-blue-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                  <span className="liquid-glass-legible">September 2026 Update</span>
                </span>
              </div>
              <p className="text-xs sm:text-sm font-medium text-slate-500 dark:text-slate-400 liquid-glass-legible">
                Inventory & Real-Time Tracking Management
              </p>
            </div>
          </div>

          {/* CENTER: Dedicated Symmetrical Search & Sort Liquid Glass Bar */}
          <div className="flex-1 max-w-2xl mx-auto w-full flex items-center gap-3">
            <div className="relative flex-1 group">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 dark:text-slate-400 liquid-glass-icon-drop pointer-events-none transition-colors group-focus-within:text-blue-500" />
              <input 
                type="text" 
                placeholder="Search reference, quantity, limit..." 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-9 py-2.5 liquid-glass-surface text-slate-900 dark:text-white text-sm rounded-[18px] focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 focus:outline-none placeholder-slate-400 dark:placeholder-slate-400 transition-all active:scale-[0.99]"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Sort Control Dropdown Pill */}
            <div className="flex items-center liquid-glass-surface rounded-[18px] overflow-hidden shrink-0">
              <select 
                value={sortConfig.key}
                onChange={(e) => setSortConfig({...sortConfig, key: e.target.value as any})}
                className="bg-transparent text-slate-800 dark:text-slate-200 text-xs font-semibold px-3 py-2.5 outline-none cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors border-r border-slate-200/50 dark:border-white/10"
              >
                <option value="custom" className="bg-white dark:bg-[#181a24] text-slate-900 dark:text-white">Custom Order</option>
                <option value="reference" className="bg-white dark:bg-[#181a24] text-slate-900 dark:text-white">Reference</option>
                <option value="quantity" className="bg-white dark:bg-[#181a24] text-slate-900 dark:text-white">Quantity</option>
                <option value="securityLimit" className="bg-white dark:bg-[#181a24] text-slate-900 dark:text-white">Limit</option>
              </select>
              <button 
                onClick={() => setSortConfig({...sortConfig, dir: sortConfig.dir === 'asc' ? 'desc' : 'asc'})}
                className="px-3 py-2.5 text-slate-500 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors active:scale-95"
                title={`Sort ${sortConfig.dir === 'asc' ? 'Descending' : 'Ascending'}`}
              >
                {sortConfig.dir === 'asc' ? <ArrowUp className="w-3.5 h-3.5 liquid-glass-icon-drop" /> : <ArrowDown className="w-3.5 h-3.5 liquid-glass-icon-drop" />}
              </button>
            </div>
          </div>

          {/* RIGHT: Action Buttons & User Control Hub */}
          <div className="flex items-center justify-end gap-2.5 shrink-0 flex-wrap">
            {canTakeItems && (
              <button
                onClick={() => {
                  setBulkTakePo('');
                  setBulkTakeSelections({});
                  setBulkTakePoModalOpen(true);
                }}
                className="liquid-glass-btn-orange inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold tracking-wide"
              >
                <PackageMinus className="h-4 w-4 liquid-glass-icon-drop" />
                <span className="liquid-glass-legible">Bulk Checkout</span>
              </button>
            )}

            {canAddBox && (
              <button
                onClick={() => setIsAddModalOpen(true)}
                className="liquid-glass-btn-blue inline-flex items-center gap-2 px-4 py-2 text-xs sm:text-sm font-semibold tracking-wide"
              >
                <Plus className="h-4 w-4 liquid-glass-icon-drop" />
                <span className="liquid-glass-legible">Add Box</span>
              </button>
            )}

            <div className="h-7 w-px bg-slate-200/60 dark:bg-white/10 mx-0.5 hidden sm:block" />

            {/* Profile Hub */}
            <div className="flex items-center gap-1.5 liquid-glass-surface p-1 rounded-[20px]">
              <div className="flex items-center pl-2 pr-2.5 gap-2.5 border-r border-slate-200/60 dark:border-white/10">
                <div className="flex flex-col items-end hidden md:flex leading-none">
                  <span className="text-xs font-bold text-slate-900 dark:text-white liquid-glass-legible">{currentUser.username}</span>
                  <span className={cn("text-[10px] font-extrabold uppercase tracking-wider bg-clip-text text-transparent bg-gradient-to-r", profileGradient)}>
                    {currentUser.role}
                  </span>
                </div>
                <div className={cn("p-[2px] rounded-full bg-gradient-to-tr shadow-sm", profileGradient)}>
                  {currentUser.avatarUrl ? (
                    <img src={currentUser.avatarUrl} alt="Avatar" loading="lazy" className="w-7 h-7 rounded-full object-cover border border-white/80 dark:border-slate-800" />
                  ) : (
                    <div className="w-7 h-7 rounded-full bg-white dark:bg-slate-800 text-slate-800 dark:text-white flex items-center justify-center font-bold text-xs uppercase shadow-inner">
                      {currentUser.username.charAt(0)}
                    </div>
                  )}
                </div>
              </div>

              {(currentUser.role === 'Admin' || currentUser.role === 'Manager') && (
                <button
                  onClick={onAdminAccess}
                  className="p-2 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-500/15 rounded-xl transition-all active:scale-95"
                  title="System Database & Analytics"
                >
                  <Database className="w-4 h-4 liquid-glass-icon-drop" />
                </button>
              )}
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="p-2 text-slate-500 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-300 hover:bg-blue-500/15 rounded-xl transition-all active:scale-95"
                title="User Preferences"
              >
                <Settings className="w-4 h-4 liquid-glass-icon-drop" />
              </button>
              <button
                onClick={onLogout}
                className="p-2 text-slate-500 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/15 rounded-xl transition-all active:scale-95"
                title="Logout"
              >
                <LogOut className="w-4 h-4 liquid-glass-icon-drop" />
              </button>
            </div>

          </div>

        </div>
      </header>

      <main className="flex-1 w-full">
        <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={filteredAndSortedItems.map(i => i.id || '')} strategy={rectSortingStrategy}>
            <div className={cn("grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6 min-h-[calc(100vh-200px)]", bulkModeActive ? "pb-32" : "pb-8")}>
              {filteredAndSortedItems.map(item => (
                <SortableKanbanBox 
                  key={item.id} 
                  item={item} 
                  onTake={() => openTakeModal(item)}
                  onAdd={() => openAddStockModal(item)}
                  onDelete={() => handleDeleteItem(item.id!)}
                  onEdit={() => { setEditItem(item); setEditModalOpen(true); }}
                  canManage={canManage}
                  canDelete={canDelete}
                  canTake={canTakeItems}
                  canAdd={canAddQuantity}
                  alertThreshold={threshold}
                  canSort={sortConfig.key === 'custom' && canManage}
                  picturePosition={globalSettings.picturePosition}
                  pictureScale={globalSettings.pictureScale}
                  isBulkMode={bulkModeActive}
                  bulkSelectionQty={bulkTakeSelections[item.id!]}
                  onBulkSelect={() => {
                      setBulkTakeItemSelectId(item.id!);
                      setBulkQtyInput(bulkTakeSelections[item.id!] || 1);
                  }}
                />
              ))}

              {canAddBox && (
                  <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="min-h-[220px] flex flex-col items-center justify-center p-6 rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-600 hover:text-slate-700 dark:hover:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/30 cursor-pointer transition-all group lg:col-span-1 md:col-span-1"
                  >
                    <Plus className="h-8 w-8 mb-2 group-hover:scale-110 transition-transform" />
                    <span className="text-xs font-bold uppercase tracking-wider mt-2">Add Box to Rack</span>
                  </button>
              )}
            </div>
          </SortableContext>
        </DndContext>

        {/* Bottom Credits Footer - Only seen when scrolled all the way to the bottom */}
        <footer className="mt-24 pt-8 pb-12 border-t border-slate-200/70 dark:border-slate-800/70 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
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
      </main>

      {/* BULK MODE FLOATING BAR */}
      {bulkModeActive && (
         <div className="fixed bottom-6 left-1/2 -translate-x-1/2 max-w-4xl w-[calc(100%-2rem)] liquid-glass-surface rounded-3xl p-4 z-40 flex justify-between items-center px-6 md:px-8 animate-in slide-in-from-bottom shadow-2xl border border-white/20 dark:border-white/10">
            <div>
               <div className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-0.5 liquid-glass-legible">Bulk Checkout Mode</div>
               <div className="text-lg md:text-xl font-bold text-slate-900 dark:text-white liquid-glass-legible">
                 PO: <span className="text-orange-500 dark:text-orange-400 font-mono">{bulkTakePo}</span>
                 <span className="text-slate-300 dark:text-slate-600 mx-2">|</span> 
                 {Object.keys(bulkTakeSelections).length} references selected
               </div>
            </div>
            <div className="flex gap-3 items-center">
                <button onClick={() => {
                  setBulkModeActive(false);
                  setBulkTakeSelections({});
                }} className="liquid-glass-btn-secondary px-4 py-2 text-sm font-semibold rounded-xl">Cancel</button>
                <button 
                  onClick={() => setBulkTakeFinalModalOpen(true)} 
                  disabled={Object.keys(bulkTakeSelections).length === 0}
                  className="liquid-glass-btn-orange px-6 py-2.5 text-sm font-bold tracking-wide rounded-2xl shadow-lg transition-all"
                >
                  Review & Confirm
                </button>
            </div>
         </div>
      )}

      {/* UNDO TOAST */}
      {pendingUndo && (
        <div className={cn(
          "fixed left-1/2 -translate-x-1/2 liquid-glass-modal text-slate-900 dark:text-white px-5 py-3.5 rounded-2xl shadow-2xl flex items-center gap-4 z-50 animate-in slide-in-from-bottom border border-white/20 dark:border-white/10",
          bulkModeActive ? "bottom-28" : "bottom-8"
        )}>
           <div className="flex flex-col">
              <span className="font-bold text-sm liquid-glass-legible">
                {pendingUndo.type === 'ADD' ? 'Added' : 'Removed'} {pendingUndo.quantityDelta} × {pendingUndo.reference}
              </span>
           </div>
           <div className="h-6 w-px bg-slate-200/60 dark:bg-white/10 mx-1"></div>
           <button 
              onClick={handleUndo} 
              className="text-orange-500 dark:text-orange-400 font-bold hover:text-orange-600 dark:hover:text-orange-300 transition-colors uppercase text-sm tracking-wider flex items-center gap-2 relative"
           >
              Undo
              <svg className="w-5 h-5 -rotate-90 origin-center text-orange-500 dark:text-orange-400" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity="0.2" />
                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="63" strokeDashoffset="0" className="animate-[toast-countdown_5s_linear_forwards]" />
              </svg>
           </button>
        </div>
      )}

      {/* USER SETTINGS MODAL */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="liquid-glass-modal max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200 p-6">
            <div>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-6 liquid-glass-legible">User Preferences</h2>
              <form onSubmit={handleSaveSettings} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Profile Picture (Avatar)</label>
                  <input 
                    type="file" 
                    accept="image/*"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        try {
                          const publicUrl = await processAvatarImage(file);
                          onUpdateUser({ avatarUrl: publicUrl });
                        } catch (err) {
                          console.error('Failed to upload avatar:', err);
                        }
                      }
                    }}
                    className="w-full text-sm text-slate-500 dark:text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-blue-50 dark:file:bg-white/10 file:text-blue-700 dark:file:text-blue-300 hover:file:bg-blue-100 transition cursor-pointer"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Theme</label>
                  <select 
                    value={currentUser.theme || 'dark'} 
                    onChange={e => onUpdateUser({ theme: e.target.value as 'dark' | 'light' })}
                    className="w-full px-4 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none"
                  >
                    <option value="dark" className="bg-white dark:bg-[#181a24] text-slate-900 dark:text-white">Dark Mode</option>
                    <option value="light" className="bg-white dark:bg-[#181a24] text-slate-900 dark:text-white">Light Mode</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Notification Method</label>
                  <select 
                    value={settingsForm.notificationMethod} 
                    onChange={e => setSettingsForm({...settingsForm, notificationMethod: e.target.value as any})}
                    className="w-full px-4 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none"
                  >
                    <option value="none" className="bg-white dark:bg-[#181a24] text-slate-900 dark:text-white">None</option>
                    <option value="email" className="bg-white dark:bg-[#181a24] text-slate-900 dark:text-white">Email</option>
                    <option value="sms" className="bg-white dark:bg-[#181a24] text-slate-900 dark:text-white">SMS</option>
                  </select>
                </div>
                {(settingsForm.notificationMethod as string) !== 'none' && (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Contact Email / Phone</label>
                    <input type="text" value={settingsForm.email || ''} onChange={(e) => setSettingsForm({...settingsForm, email: e.target.value})} className="w-full px-4 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none" placeholder="example@company.com" />
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Custom Low Stock Threshold (%)</label>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">Triggers low stock alert when quantity falls below this percentage of the security limit.</p>
                  <input type="number" min="100" max="500" value={settingsForm.alertThreshold} onChange={(e) => setSettingsForm({...settingsForm, alertThreshold: parseInt(e.target.value) || 150})} className="w-full px-4 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none" />
                </div>
                <div className="pt-6 flex justify-end gap-3 border-t border-slate-200/50 dark:border-white/10 mt-6">
                  <button type="button" onClick={() => setIsSettingsOpen(false)} className="liquid-glass-btn-secondary px-4 py-2 text-sm font-semibold rounded-xl">Cancel</button>
                  <button type="submit" className="liquid-glass-btn-blue px-6 py-2.5 text-sm font-bold rounded-xl shadow-lg">Save Settings</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* BULK TAKE PO INPUT MODAL */}
      {bulkTakePoModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="liquid-glass-modal max-w-sm w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="liquid-glass-surface border-b border-slate-200/50 dark:border-white/10 p-6">
                <h2 className="text-xl font-bold text-slate-900 dark:text-white liquid-glass-legible">Start Bulk Checkout</h2>
                <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Enter the PO to begin selection</p>
            </div>
            <div className="p-6">
              <form onSubmit={(e) => {
                  e.preventDefault();
                  if (!/^\d{12}$/.test(bulkTakePo)) {
                    alert("PO must be exactly 12 numbers.");
                    return;
                  }
                  setBulkTakePoModalOpen(false);
                  setBulkModeActive(true);
              }} className="space-y-6">
                <div>
                  <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                    PO Number (12 digits) *
                  </label>
                  <input
                    type="text" required pattern="\d{12}" maxLength={12} autoFocus
                    value={bulkTakePo} onChange={(e) => setBulkTakePo(e.target.value)}
                    placeholder="Enter exactly 12 digits"
                    className="w-full px-4 py-3 font-mono liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-orange-500/50 outline-none text-center"
                  />
                </div>
                <div className="flex justify-end gap-3 mt-4">
                  <button type="button" onClick={() => setBulkTakePoModalOpen(false)} className="liquid-glass-btn-secondary px-4 py-2 text-sm font-semibold rounded-xl">
                    Cancel
                  </button>
                  <button type="submit" className="liquid-glass-btn-orange px-6 py-2 text-sm font-bold rounded-xl shadow-lg">
                    Start Selection
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* BULK TAKE SELECT QUANTITY MODAL (FOR INDIVIDUAL ITEM) */}
      {bulkTakeItemSelectId && (() => {
          const it = items.find(i => i.id === bulkTakeItemSelectId);
          if (!it) return null;
          return (
            <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
              <div className="liquid-glass-modal max-w-sm w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                <div className="p-6 border-b border-slate-200/50 dark:border-white/10 liquid-glass-surface">
                  <h2 className="text-xl font-bold text-slate-900 dark:text-white liquid-glass-legible">Quantity to Remove</h2>
                  <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">{it.reference} (Max: {it.quantity})</p>
                </div>
                <div className="p-6">
                  <form onSubmit={(e) => {
                      e.preventDefault();
                      setBulkTakeSelections(prev => ({...prev, [it.id!]: bulkQtyInput}));
                      setBulkTakeItemSelectId(null);
                  }}>
                      <input
                        type="number" min="1" max={it.quantity} required autoFocus
                        value={bulkQtyInput} onChange={(e) => setBulkQtyInput(parseInt(e.target.value) || 1)}
                        className="w-full px-4 py-3 text-2xl font-mono liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-orange-500/50 outline-none text-center mb-6"
                      />
                      <div className="flex justify-between gap-3">
                          {bulkTakeSelections[it.id!] ? (
                            <button type="button" onClick={() => {
                                setBulkTakeSelections(prev => { const n = {...prev}; delete n[it.id!]; return n; });
                                setBulkTakeItemSelectId(null);
                            }} className="liquid-glass-btn-rose px-4 py-2 rounded-xl text-sm font-bold">
                                Remove
                            </button>
                          ) : <div/>}

                          <div className="flex gap-2">
                              <button type="button" onClick={() => setBulkTakeItemSelectId(null)} className="liquid-glass-btn-secondary px-4 py-2 text-sm font-semibold rounded-xl">Cancel</button>
                              <button type="submit" className="liquid-glass-btn-orange px-6 py-2 text-sm font-bold rounded-xl shadow-lg">Save</button>
                          </div>
                      </div>
                  </form>
                </div>
              </div>
            </div>
          );
      })()}

      {/* BULK TAKE FINAL REVIEW MODAL */}
      {bulkTakeFinalModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="liquid-glass-modal max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200 max-h-[85vh] flex flex-col">
            <div className="liquid-glass-surface border-b border-slate-200/50 dark:border-white/10 p-6 shrink-0">
                <h2 className="text-xl font-bold text-slate-900 dark:text-white liquid-glass-legible">Review & Confirm</h2>
                <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">PO: <span className="font-mono text-orange-500 dark:text-orange-400 font-bold">{bulkTakePo}</span></p>
            </div>
            <div className="p-6 flex-1 overflow-y-auto">
                <div className="space-y-3">
                  {Object.entries(bulkTakeSelections).map(([id, qty]) => {
                      const it = items.find(i => i.id === id);
                      if (!it) return null;
                      return (
                          <div key={id} className="flex justify-between items-center p-3.5 liquid-glass-surface rounded-2xl border border-white/20 dark:border-white/5">
                             <div className="font-bold text-slate-900 dark:text-white liquid-glass-legible">{it.reference}</div>
                             <div className="font-mono text-orange-600 dark:text-orange-400 font-bold bg-orange-500/15 border border-orange-500/30 px-2.5 py-1 rounded-xl">-{qty}</div>
                          </div>
                      );
                  })}
                </div>
            </div>
            <div className="p-6 border-t border-slate-200/50 dark:border-white/10 flex justify-end gap-3 shrink-0">
                  <button type="button" onClick={() => setBulkTakeFinalModalOpen(false)} className="liquid-glass-btn-secondary px-5 py-2 text-sm font-semibold rounded-xl">
                    Back to edit
                  </button>
                  <button onClick={handleBulkTakeSubmit} className="liquid-glass-btn-orange px-6 py-2.5 text-sm font-bold rounded-xl shadow-lg">
                    Confirm Checkout
                  </button>
            </div>
          </div>
        </div>
      )}

      {/* TAKE MODAL */}
      {takeModalOpen && activeItem && (
        <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="liquid-glass-modal max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="liquid-glass-surface border-b border-slate-200/50 dark:border-white/10 p-6 flex justify-between items-start">
              <div>
                <h2 className="text-xl font-bold text-slate-900 dark:text-white liquid-glass-legible">Withdraw Stock</h2>
                <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">{activeItem.reference}</p>
              </div>
              <div className="text-right">
                <span className="block text-[10px] uppercase text-slate-500 font-bold">Current Qty</span>
                <span className="text-3xl font-mono text-blue-600 dark:text-blue-400 font-black leading-none">{activeItem.quantity}</span>
              </div>
            </div>
            <div className="p-6">
              <form onSubmit={handleTakeSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                    Reason for Removal
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['Normal Use', 'Broken', 'Lost'] as const).map(reason => (
                      <button
                        key={reason}
                        type="button"
                        onClick={() => setTakeReason(reason)}
                        className={cn(
                          "px-3 py-2 text-xs font-bold rounded-xl transition-all",
                          takeReason === reason 
                            ? reason === 'Normal Use' ? "liquid-glass-btn-blue text-white shadow-md" 
                            : reason === 'Broken' ? "liquid-glass-btn-orange text-white shadow-md"
                            : "liquid-glass-btn-rose text-white shadow-md"
                            : "liquid-glass-btn-secondary"
                        )}
                      >
                        {reason}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                    Quantity to Remove
                  </label>
                  <input
                    type="number" min="1" max={activeItem.quantity} required
                    value={takeQty} onChange={(e) => setTakeQty(parseInt(e.target.value) || 1)}
                    className="w-full px-4 py-3 text-2xl font-mono liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none text-center"
                  />
                </div>
                {takeReason === 'Normal Use' && (
                  <div>
                    <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                      PO Number (12 digits) *
                    </label>
                    <input
                      type="text" required pattern="\d{12}" maxLength={12}
                      value={takePo} onChange={(e) => setTakePo(e.target.value)}
                      className="w-full px-4 py-3 font-mono liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none"
                      placeholder="123456789012"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                    {takeReason === 'Normal Use' ? 'PO Document & Materials Photo (Optional)' : 'Photo Proof (Optional)'}
                  </label>
                  {!takePic ? (
                    <label className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-slate-300/60 dark:border-white/10 rounded-2xl liquid-glass-surface hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors group">
                       <Camera className="h-8 w-8 text-slate-400 dark:text-slate-400 group-hover:text-blue-500 mb-2 transition-colors" />
                       <span className="text-sm font-medium text-slate-600 dark:text-slate-300 group-hover:text-blue-500">Tap to Camera / Upload</span>
                       <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => startImageCrop(e, 'take')} />
                    </label>
                  ) : (
                    <div className="relative rounded-2xl overflow-hidden border border-white/20 dark:border-white/10 group">
                      <img src={takePic} alt="Captured" loading="lazy" className="w-full aspect-video object-cover" />
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                         <label className="px-4 py-2 liquid-glass-btn-secondary text-sm font-semibold rounded-xl cursor-pointer">
                           Retake Picture
                           <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => startImageCrop(e, 'take')} />
                         </label>
                      </div>
                    </div>
                  )}
                </div>

                <div className="pt-6 flex justify-end gap-3 mt-4 border-t border-slate-200/50 dark:border-white/10">
                  <button type="button" onClick={() => { setTakeModalOpen(false); setActiveItem(null); }} className="liquid-glass-btn-secondary px-5 py-2 text-sm font-semibold rounded-xl">
                    Cancel
                  </button>
                  <button type="submit" className="liquid-glass-btn-blue px-6 py-2.5 text-sm font-bold rounded-xl shadow-lg">
                    Confirm Withdrawal
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ADD STOCK MODAL */}
      {addStockModalOpen && activeItem && (
        <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="liquid-glass-modal max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="liquid-glass-surface border-b border-slate-200/50 dark:border-white/10 p-6 flex justify-between items-start">
              <div>
                <h2 className="text-xl font-bold text-slate-900 dark:text-white liquid-glass-legible">Add Stock</h2>
                <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">{activeItem.reference}</p>
              </div>
              <div className="text-right">
                <span className="block text-[10px] uppercase text-slate-500 font-bold">Current Qty</span>
                <span className="text-3xl font-mono text-emerald-600 dark:text-emerald-400 font-black leading-none">{activeItem.quantity}</span>
              </div>
            </div>
            <div className="p-6">
              <form onSubmit={handleAddStockSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">
                    Quantity to Add
                  </label>
                  <input
                    type="number" min="1" required
                    value={addQty} onChange={(e) => setAddQty(parseInt(e.target.value) || 1)}
                    className="w-full px-4 py-3 text-2xl font-mono liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-emerald-500/50 outline-none text-center"
                  />
                </div>
                <div className="pt-6 flex justify-end gap-3 mt-4 border-t border-slate-200/50 dark:border-white/10">
                  <button type="button" onClick={() => { setAddStockModalOpen(false); setActiveItem(null); }} className="liquid-glass-btn-secondary px-5 py-2 text-sm font-semibold rounded-xl">
                    Cancel
                  </button>
                  <button type="submit" className="liquid-glass-btn-emerald px-6 py-2.5 text-sm font-bold rounded-xl shadow-lg">
                    Confirm Restock
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ADD BOX MODAL */}
      {isAddModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="liquid-glass-modal max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-6 liquid-glass-legible">Add New Kanban Box</h2>
              <form onSubmit={handleAddItem} className="space-y-4">
                <div>
                  <label htmlFor="reference" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Reference Name / ID *</label>
                  <input id="reference" type="text" required value={newReference} onChange={(e) => setNewReference(e.target.value)} className="w-full px-4 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none" placeholder="e.g. SENSOR-X9" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="quantity" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Initial Qty</label>
                    <input id="quantity" type="number" min="0" required value={newQuantity} onChange={(e) => setNewQuantity(parseInt(e.target.value) || 0)} className="w-full px-4 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none" />
                  </div>
                  <div>
                    <label htmlFor="securityLimit" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Alert Limit</label>
                    <input id="securityLimit" type="number" min="0" required value={newSecurityLimit} onChange={(e) => setNewSecurityLimit(parseInt(e.target.value) || 0)} className="w-full px-4 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Box Picture (Optional)</label>
                  {!newPicture ? (
                    <label className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-slate-300/60 dark:border-white/10 rounded-2xl liquid-glass-surface hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors group">
                       <Camera className="h-6 w-6 text-slate-400 dark:text-slate-400 group-hover:text-blue-500 mb-1 transition-colors" />
                       <span className="text-xs font-medium text-slate-600 dark:text-slate-300 group-hover:text-blue-500">Tap to Camera / Upload</span>
                       <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => startImageCrop(e, 'new')} />
                    </label>
                  ) : (
                    <div className="relative rounded-2xl overflow-hidden border border-white/20 dark:border-white/10 group h-32">
                      <img src={newPicture} alt="Captured Box" loading="lazy" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                         <label className="px-3 py-1.5 liquid-glass-btn-secondary text-white text-xs rounded-xl cursor-pointer">
                           Retake Picture
                           <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => startImageCrop(e, 'new')} />
                         </label>
                      </div>
                    </div>
                  )}
                </div>
                <div className="pt-6 flex justify-end gap-3 border-t border-slate-200/50 dark:border-white/10 mt-6">
                  <button type="button" onClick={() => setIsAddModalOpen(false)} className="liquid-glass-btn-secondary px-4 py-2 text-sm font-semibold rounded-xl">Cancel</button>
                  <button type="submit" className="liquid-glass-btn-blue px-6 py-2 text-sm font-bold rounded-xl shadow-lg">Add Box</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* EDIT BOX MODAL */}
      {editModalOpen && editItem && (
        <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="liquid-glass-modal max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-6 liquid-glass-legible">Edit Box Details</h2>
              <form onSubmit={handleEditItem} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Reference Name / ID *</label>
                  <input type="text" required value={editItem.reference} onChange={(e) => setEditItem({...editItem, reference: e.target.value})} className="w-full px-4 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Current Qty</label>
                    <input type="number" min="0" required value={editItem.quantity} onChange={(e) => setEditItem({...editItem, quantity: parseInt(e.target.value) || 0})} className="w-full px-4 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Security Limit</label>
                    <input type="number" min="0" required value={editItem.securityLimit} onChange={(e) => setEditItem({...editItem, securityLimit: parseInt(e.target.value) || 0})} className="w-full px-4 py-2.5 liquid-glass-surface border border-slate-200/50 dark:border-white/10 text-slate-900 dark:text-white rounded-xl focus:ring-2 focus:ring-blue-500/50 outline-none" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Box Picture</label>
                  {!editItem.pictureUrl ? (
                    <label className="flex flex-col items-center justify-center p-4 border-2 border-dashed border-slate-300/60 dark:border-white/10 rounded-2xl liquid-glass-surface hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer transition-colors group">
                       <Camera className="h-6 w-6 text-slate-400 dark:text-slate-400 group-hover:text-blue-500 mb-1 transition-colors" />
                       <span className="text-xs font-medium text-slate-600 dark:text-slate-300 group-hover:text-blue-500">Tap to Camera / Upload</span>
                       <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => startImageCrop(e, 'edit')} />
                    </label>
                  ) : (
                    <div className="relative rounded-2xl overflow-hidden border border-white/20 dark:border-white/10 group h-32">
                      <img src={editItem.pictureUrl} alt="Captured Box" loading="lazy" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                         <label className="px-3 py-1.5 liquid-glass-btn-secondary text-white text-xs rounded-xl cursor-pointer">
                           Retake Picture
                           <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => startImageCrop(e, 'edit')} />
                         </label>
                      </div>
                    </div>
                  )}
                </div>
                <div className="pt-6 flex justify-end gap-3 border-t border-slate-200/50 dark:border-white/10 mt-6">
                  <button type="button" onClick={() => { setEditModalOpen(false); setEditItem(null); }} className="liquid-glass-btn-secondary px-4 py-2 text-sm font-semibold rounded-xl">Cancel</button>
                  <button type="submit" className="liquid-glass-btn-blue px-6 py-2 text-sm font-bold rounded-xl shadow-lg">Save Changes</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {deleteModalOpen && (
        <div className="fixed inset-0 bg-slate-900/60 dark:bg-black/75 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="liquid-glass-modal max-w-sm w-full overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="flex items-center justify-center w-12 h-12 rounded-2xl liquid-glass-surface mb-4 mx-auto border border-rose-500/30 text-rose-500">
                <Trash2 className="h-6 w-6 liquid-glass-icon-drop" />
              </div>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-2 text-center liquid-glass-legible">Delete Kanban Box?</h2>
              <p className="text-slate-500 dark:text-slate-400 text-sm text-center mb-6">
                Are you sure you want to delete this kanban box and all its history data? This action cannot be undone.
              </p>
              <div className="flex justify-end gap-3 w-full">
                <button type="button" onClick={() => { setDeleteModalOpen(false); setItemToDelete(null); }} className="flex-1 px-4 py-2.5 liquid-glass-btn-secondary text-sm font-semibold rounded-xl">
                  Cancel
                </button>
                <button type="button" onClick={confirmDelete} className="flex-1 px-4 py-2.5 liquid-glass-btn-rose text-sm font-bold rounded-xl shadow-lg">
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CROP MODAL */}
      {cropImageSrc && (
        <CropModal
           imageSrc={cropImageSrc}
           maxDimension={cropTarget === 'take' ? 800 : 600}
           onCropComplete={handleCropComplete}
           onCancel={handleCropCancel}
        />
      )}

    </div>
  );
}

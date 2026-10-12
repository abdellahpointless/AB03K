import * as XLSX from 'xlsx';
import { Transaction, KanbanItem } from '../db';
import { localDb, WeeklyArchiveRecord } from '../db/indexedDb';

export interface WeekPeriodInfo {
  year: number;
  weekNumber: number;
  weekId: string; // e.g. "2026-W36"
  startDate: string;
  endDate: string;
  startTime: number;
  endTime: number;
  formattedRange: string;
  label: string;
}

/**
 * Calculates ISO-8601 week number and precise start/end dates
 */
export function getWeekDetails(targetDate: Date | number = new Date()): WeekPeriodInfo {
  const d = typeof targetDate === 'number' ? new Date(targetDate) : new Date(targetDate.getTime());
  d.setHours(0, 0, 0, 0);

  // ISO week calculation (Thursday in current week determines year)
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7; // 0 = Monday, 6 = Sunday
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7));
  }
  const weekNumber = 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
  const year = new Date(firstThursday).getFullYear();
  const weekId = `${year}-W${String(weekNumber).padStart(2, '0')}`;

  // Monday 00:00:00 of this week
  const monday = new Date(d.valueOf());
  monday.setDate(d.getDate() - dayNr);
  monday.setHours(0, 0, 0, 0);

  // Sunday 23:59:59.999 of this week
  const sunday = new Date(monday.valueOf());
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const formattedRange = `${monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${sunday.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return {
    year,
    weekNumber,
    weekId,
    startDate: monday.toISOString(),
    endDate: sunday.toISOString(),
    startTime: monday.getTime(),
    endTime: sunday.getTime(),
    formattedRange,
    label: `Week ${weekNumber}, ${year}`
  };
}

/**
 * Generates an Excel binary (.xlsx) with styled sheets for transactions, summary, and inventory
 */
export function buildExcelFile(
  transactions: Transaction[],
  items: KanbanItem[],
  title: string = 'Kanban Records'
): { buffer: Uint8Array; base64: string } {
  const wb = XLSX.utils.book_new();

  // 1. Transactions Sheet
  const txRows = transactions.map(t => ({
    'Transaction ID': t.id || '',
    'Date': new Date(t.date).toLocaleDateString(),
    'Time': new Date(t.date).toLocaleTimeString(),
    'Timestamp (ISO)': new Date(t.date).toISOString(),
    'Action Type': t.type,
    'Reference': t.reference,
    'Quantity': t.quantity || 1,
    'User': t.username,
    'User ID': t.userId,
    'Reason': t.reason || (t.type === 'ADD' ? 'Restock' : 'Normal Use'),
    'PO / Delivery Ref': t.poNumber || '',
    'Photo Attached': t.pictureUrl ? 'Yes' : 'No'
  }));

  const txSheet = XLSX.utils.json_to_sheet(txRows);
  // Auto-fit column widths
  txSheet['!cols'] = [
    { wch: 36 }, // ID
    { wch: 12 }, // Date
    { wch: 10 }, // Time
    { wch: 24 }, // ISO
    { wch: 12 }, // Type
    { wch: 22 }, // Reference
    { wch: 10 }, // Quantity
    { wch: 18 }, // User
    { wch: 36 }, // User ID
    { wch: 16 }, // Reason
    { wch: 22 }, // PO
    { wch: 14 }  // Photo
  ];
  XLSX.utils.book_append_sheet(wb, txSheet, 'Transactions');

  // 2. Summary Sheet
  const totalAdd = transactions.filter(t => t.type === 'ADD').reduce((sum, t) => sum + (t.quantity || 1), 0);
  const totalRemove = transactions.filter(t => t.type === 'REMOVE').reduce((sum, t) => sum + (t.quantity || 1), 0);
  const addCount = transactions.filter(t => t.type === 'ADD').length;
  const removeCount = transactions.filter(t => t.type === 'REMOVE').length;

  // Breakdown by Reference
  const refMap: Record<string, { added: number; removed: number; transactions: number }> = {};
  transactions.forEach(t => {
    if (!refMap[t.reference]) {
      refMap[t.reference] = { added: 0, removed: 0, transactions: 0 };
    }
    refMap[t.reference].transactions++;
    if (t.type === 'ADD') refMap[t.reference].added += (t.quantity || 1);
    if (t.type === 'REMOVE') refMap[t.reference].removed += (t.quantity || 1);
  });

  const summaryData = [
    { 'Metric': 'Report Title', 'Value': title },
    { 'Metric': 'Generated At', 'Value': new Date().toLocaleString() },
    { 'Metric': 'Total Transactions', 'Value': transactions.length },
    { 'Metric': 'Stock Additions (Operations)', 'Value': addCount },
    { 'Metric': 'Stock Withdrawals (Operations)', 'Value': removeCount },
    { 'Metric': 'Total Units Added', 'Value': totalAdd },
    { 'Metric': 'Total Units Withdrawn', 'Value': totalRemove },
    { 'Metric': 'Net Unit Flow', 'Value': totalAdd - totalRemove },
    { 'Metric': 'Unique Items Handled', 'Value': Object.keys(refMap).length }
  ];

  const summarySheet = XLSX.utils.json_to_sheet(summaryData);
  summarySheet['!cols'] = [{ wch: 30 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Executive Summary');

  // Reference breakdown table in summary
  const refBreakdown = Object.entries(refMap).map(([ref, stats]) => ({
    'Reference': ref,
    'Total Withdrawn': stats.removed,
    'Total Added': stats.added,
    'Net Change': stats.added - stats.removed,
    'Total Activity Count': stats.transactions
  })).sort((a, b) => b['Total Withdrawn'] - a['Total Withdrawn']);

  const refSheet = XLSX.utils.json_to_sheet(refBreakdown);
  refSheet['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, refSheet, 'Reference Breakdown');

  // 3. Current Inventory Snapshot Sheet
  if (items && items.length > 0) {
    const invRows = items.map(item => {
      const isCritical = item.quantity <= item.securityLimit;
      const isLow = !isCritical && item.quantity <= item.securityLimit * 1.5;
      return {
        'Reference': item.reference,
        'Current Stock': item.quantity,
        'Security Limit': item.securityLimit,
        'Status': isCritical ? 'CRITICAL' : isLow ? 'LOW STOCK' : 'HEALTHY'
      };
    });
    const invSheet = XLSX.utils.json_to_sheet(invRows);
    invSheet['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, invSheet, 'Current Inventory Status');
  }

  // Generate binary output
  const wbOut = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const buffer = new Uint8Array(wbOut);

  // Convert to Base64 for persistent storage in IndexedDB / JSON
  let binary = '';
  const len = buffer.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  const base64 = btoa(binary);

  return { buffer, base64 };
}

/**
 * Triggers a browser download of an Excel file from a Uint8Array or base64 string
 */
export function downloadExcelBlob(data: Uint8Array | string, filename: string) {
  let blob: Blob;
  if (typeof data === 'string') {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  } else {
    blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Automatically groups all transactions by week, compiles Excel archives,
 * saves them in IndexedDB and syncs with server filesystem so files are permanently ready.
 */
export async function syncAllWeeklyArchives(
  transactions: Transaction[],
  items: KanbanItem[]
): Promise<WeeklyArchiveRecord[]> {
  const currentWeek = getWeekDetails();
  const weekGroups: Record<string, { info: WeekPeriodInfo; txs: Transaction[] }> = {};

  // Always ensure current week exists in the group
  weekGroups[currentWeek.weekId] = {
    info: currentWeek,
    txs: []
  };

  // Group all transactions into their respective calendar weeks
  transactions.forEach(tx => {
    const info = getWeekDetails(tx.date);
    if (!weekGroups[info.weekId]) {
      weekGroups[info.weekId] = {
        info,
        txs: []
      };
    }
    weekGroups[info.weekId].txs.push(tx);
  });

  const results: WeeklyArchiveRecord[] = [];

  // For each week, check if we need to generate/update the archive
  for (const [weekId, { info, txs }] of Object.entries(weekGroups)) {
    const existing = await localDb.weeklyArchives.get(weekId);
    const isCurrent = weekId === currentWeek.weekId;
    
    // Regenerate if doesn't exist, or if count changed, or if it's the current week
    const needsRegen = !existing || existing.recordCount !== txs.length || isCurrent;

    if (needsRegen) {
      const filename = `Kanban_Records_${info.year}_W${String(info.weekNumber).padStart(2, '0')}.xlsx`;
      const title = `Kanban Records - ${info.label} (${info.formattedRange})`;
      const { base64, buffer } = buildExcelFile(txs, items, title);

      const addCount = txs.filter(t => t.type === 'ADD').length;
      const removeCount = txs.filter(t => t.type === 'REMOVE').length;

      const record: WeeklyArchiveRecord = {
        id: weekId,
        year: info.year,
        weekNumber: info.weekNumber,
        startDate: info.startDate,
        endDate: info.endDate,
        formattedRange: info.formattedRange,
        filename,
        recordCount: txs.length,
        addCount,
        removeCount,
        generatedAt: Date.now(),
        fileBase64: base64,
        fileSize: buffer.byteLength,
        isCurrentWeek: isCurrent
      };

      // 1. Save in local IndexedDB (guaranteed permanent storage in browser)
      await localDb.weeklyArchives.put(record);
      results.push(record);

      // 2. Also send to server to persist on server disk
      try {
        await fetch('/api/archives', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record)
        });
      } catch {
        // Server fetch is optional if offline
      }
    } else {
      results.push(existing);
    }
  }

  // Sort descending: newest weeks first
  results.sort((a, b) => b.id.localeCompare(a.id));
  return results;
}

/**
 * Export all records across all time into one master Excel file
 */
export function exportMasterExcel(transactions: Transaction[], items: KanbanItem[]) {
  const filename = `Kanban_Master_Database_All_Records_${new Date().toISOString().slice(0, 10)}.xlsx`;
  const { buffer } = buildExcelFile(transactions, items, 'Kanban Master Database - All Records');
  downloadExcelBlob(buffer, filename);
}

import Dexie, { Table } from 'dexie';
import { KanbanItem, Transaction, User } from '../db';

export interface WeeklyArchiveRecord {
  id: string; // e.g. "2026-W36"
  year: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  formattedRange: string;
  filename: string;
  recordCount: number;
  addCount: number;
  removeCount: number;
  generatedAt: number;
  fileBase64: string;
  fileSize: number;
  isCurrentWeek?: boolean;
}

export interface CachedItemHistory {
  itemId: string;
  transactions: Transaction[];
  fetchedAt: number;
}

export class KanbanDexieDB extends Dexie {
  transactions!: Table<Transaction, string>;
  items!: Table<KanbanItem, string>;
  users!: Table<User, string>;
  weeklyArchives!: Table<WeeklyArchiveRecord, string>;
  itemHistoryCache!: Table<CachedItemHistory, string>;

  constructor() {
    super('KanbanMasterDB');
    this.version(1).stores({
      transactions: 'id, date, reference, type, poNumber, username',
      items: 'id, reference',
      users: 'id, username',
      weeklyArchives: 'id, year, weekNumber, generatedAt'
    });

    this.version(2).stores({
      transactions: 'id, date, reference, type, poNumber, username, itemId',
      items: 'id, reference, order, updated_at',
      users: 'id, username',
      weeklyArchives: 'id, year, weekNumber, generatedAt',
      itemHistoryCache: 'itemId, fetchedAt'
    });
  }
}

export const localDb = new KanbanDexieDB();

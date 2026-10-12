export type Role = 'Admin' | 'Manager' | 'Operator' | 'Warehouse' | 'Overview';

export interface User {
  id?: string;
  username: string;
  password?: string;
  email?: string;
  role: Role;
  theme?: 'dark' | 'light';
  avatarUrl?: string;
  settings?: {
    notificationMethod: 'none' | 'email' | 'sms' | 'push';
    alertThreshold: number;
    email?: string;
  };
}

export interface KanbanItem {
  id?: string;
  reference: string;
  quantity: number;
  securityLimit: number;
  pictureUrl?: string; // storage URL or base64 fallback
  order?: number;
  updated_at?: string;
}

export interface Transaction {
  id?: string;
  itemId: string;
  reference: string;
  type: 'ADD' | 'REMOVE';
  reason?: 'Normal Use' | 'Broken' | 'Lost';
  quantity: number;
  poNumber?: string;
  pictureUrl?: string; // base64 max quality compressed
  date: number; // timestamp
  userId: string;
  username: string;
}

export interface DatabaseState {
  users: User[];
  items: KanbanItem[];
  transactions: Transaction[];
  settings?: {
    picturePosition: string; // e.g. "50% 50%"
    pictureScale: number; // e.g. 1.0
  };
}


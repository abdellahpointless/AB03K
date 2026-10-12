import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import http from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import { randomUUID } from 'crypto';

const DB_FILE = path.join(process.cwd(), 'database.json');

let db: any = {
  users: [],
  items: [],
  transactions: [],
  settings: {
    picturePosition: 'center'
  }
};

function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      db = {
        users: loaded.users || [],
        items: loaded.items || [],
        transactions: loaded.transactions || [],
        settings: loaded.settings || { picturePosition: 'center' }
      };
    } catch (e) {
      console.error("Failed to load db", e);
    }
  }
}

function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

async function startServer() {
  loadDb();

  const app = express();
  const PORT = 3000;
  app.use(express.json({ limit: '50mb' }));

  const server = http.createServer(app);
  const io = new Server(server, { 
    cors: { origin: '*' },
    maxHttpBufferSize: 1e8 // 100MB payload limit
  });

  io.on('connection', (socket) => {
    // Send initial state on connection
    socket.emit('init', db);

    // Handlers for modifying data
    socket.on('addUser', (user) => {
      user.id = user.id || randomUUID();
      db.users.push(user);
      saveDb();
      io.emit('usersUpdated', db.users);
    });

    socket.on('updateUser', (userId, updates) => {
      const idx = db.users.findIndex((u: any) => u.id === userId);
      if (idx > -1) {
        db.users[idx] = { ...db.users[idx], ...updates };
        saveDb();
        io.emit('usersUpdated', db.users);
      }
    });

    socket.on('addItem', (item) => {
      item.id = item.id || randomUUID();
      db.items.push(item);
      saveDb();
      io.emit('itemsUpdated', db.items);
    });
    
    socket.on('updateItem', (itemId, updates) => {
      const idx = db.items.findIndex((i: any) => i.id === itemId);
      if (idx > -1) {
        db.items[idx] = { ...db.items[idx], ...updates };
        saveDb();
        io.emit('itemsUpdated', db.items);
      }
    });

    socket.on('reorderItems', (updates: { id: string, order: number }[]) => {
      updates.forEach(u => {
        const idx = db.items.findIndex((i: any) => i.id === u.id);
        if (idx > -1) {
          db.items[idx].order = u.order;
        }
      });
      saveDb();
      io.emit('itemsUpdated', db.items);
    });

    socket.on('deleteItem', (itemId) => {
      db.items = db.items.filter((i: any) => i.id !== itemId);
      saveDb();
      io.emit('itemsUpdated', db.items);
    });

    socket.on('updateSettings', (updates) => {
      db.settings = { ...db.settings, ...updates };
      saveDb();
      io.emit('settingsUpdated', db.settings);
    });

    socket.on('addTransaction', (transaction) => {
      transaction.id = transaction.id || randomUUID();
      db.transactions.push(transaction);
      saveDb();
      io.emit('transactionsUpdated', db.transactions);
    });

    socket.on('deleteTransaction', (transactionId) => {
      db.transactions = db.transactions.filter((t: any) => t.id !== transactionId);
      saveDb();
      io.emit('transactionsUpdated', db.transactions);
    });
  });

  // Archives directory setup
  const ARCHIVES_DIR = path.join(process.cwd(), 'archives');
  if (!fs.existsSync(ARCHIVES_DIR)) {
    try {
      fs.mkdirSync(ARCHIVES_DIR, { recursive: true });
    } catch (e) {
      console.error("Could not create archives dir:", e);
    }
  }
  const ARCHIVES_META_FILE = path.join(ARCHIVES_DIR, 'archives.json');

  function getArchivesList(): any[] {
    if (fs.existsSync(ARCHIVES_META_FILE)) {
      try {
        return JSON.parse(fs.readFileSync(ARCHIVES_META_FILE, 'utf-8'));
      } catch {
        return [];
      }
    }
    return [];
  }

  function saveArchivesList(list: any[]) {
    try {
      fs.writeFileSync(ARCHIVES_META_FILE, JSON.stringify(list, null, 2));
    } catch (e) {
      console.error("Failed to save archives metadata:", e);
    }
  }

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/archives", (req, res) => {
    res.json(getArchivesList());
  });

  app.post("/api/archives", (req, res) => {
    try {
      const { id, filename, fileBase64, recordCount, weekNumber, year, formattedRange, startDate, endDate, isCurrentWeek } = req.body;
      if (!id || !filename || !fileBase64) {
        return res.status(400).json({ error: "Missing required archive data" });
      }

      // Save binary file on disk
      const filePath = path.join(ARCHIVES_DIR, `${id}.xlsx`);
      const fileBuffer = Buffer.from(fileBase64, 'base64');
      fs.writeFileSync(filePath, fileBuffer);

      // Update meta list
      const list = getArchivesList();
      const existingIdx = list.findIndex((a: any) => a.id === id);
      const meta = {
        id,
        filename,
        recordCount,
        weekNumber,
        year,
        formattedRange,
        startDate,
        endDate,
        fileSize: fileBuffer.length,
        generatedAt: Date.now(),
        isCurrentWeek
      };

      if (existingIdx > -1) {
        list[existingIdx] = meta;
      } else {
        list.unshift(meta);
      }
      saveArchivesList(list);

      res.json({ success: true, archive: meta });
    } catch (e) {
      console.error("Error saving archive:", e);
      res.status(500).json({ error: "Failed to save archive" });
    }
  });

  app.get("/api/archives/:id/download", (req, res) => {
    const { id } = req.params;
    const filePath = path.join(ARCHIVES_DIR, `${id}.xlsx`);
    if (fs.existsSync(filePath)) {
      const list = getArchivesList();
      const meta = list.find((a: any) => a.id === id);
      const filename = meta ? meta.filename : `Kanban_Archive_${id}.xlsx`;
      res.download(filePath, filename);
    } else {
      res.status(404).json({ error: "Archive file not found" });
    }
  });

  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    // Special bootstrap check: if no users and root admin logs in
    if (db.users.length === 0 && username === 'admin' && password === '121') {
      const newUser = {
         id: randomUUID(),
         username: 'admin',
         password: '121',
         role: 'Admin',
         theme: 'dark',
         settings: { notificationMethod: 'none', alertThreshold: 150 }
      };
      db.users.push(newUser);
      saveDb();
      res.json({ success: true, user: newUser });
      return;
    }
    
    const user = db.users.find((u: any) => u.username === username && u.password === password);
    if (user) {
      res.json({ success: true, user });
    } else {
      res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // For Express 4
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

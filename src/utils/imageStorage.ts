import { supabase, isSupabaseConfigured } from '../supabase';

const BUCKET_NAME = 'kanban-images';

/**
 * Resizes an image file, blob, or base64 data URL to given maxWidth/maxHeight and quality.
 * Returns a high-efficiency JPEG Blob.
 */
export async function resizeImage(
  source: string | Blob | File,
  maxWidth: number,
  maxHeight: number,
  quality = 0.8
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    let objectUrl: string | null = null;
    if (typeof source === 'string') {
      img.src = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      img.src = objectUrl;
    }

    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);

      let width = img.naturalWidth || img.width;
      let height = img.naturalHeight || img.height;

      // Scale proportionally
      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width = Math.max(1, Math.floor(width * ratio));
        height = Math.max(1, Math.floor(height * ratio));
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas 2D context unavailable'));
        return;
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to create image blob from canvas'));
          }
        },
        'image/jpeg',
        quality
      );
    };

    img.onerror = (err) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(err);
    };
  });
}

/**
 * Converts a Blob to a base64 DataURL (used for offline mode fallback)
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Uploads an image blob to Supabase Storage bucket 'kanban-images'.
 * Uses a unique UUID filename so browsers cache it permanently.
 * In offline mode (Supabase not configured) the image is kept as a base64 data URL.
 */
export async function uploadImageToStorage(
  blob: Blob,
  folder: 'items' | 'proofs' | 'avatars'
): Promise<string> {
  if (!isSupabaseConfigured) {
    return blobToDataUrl(blob);
  }

  const fileName = `${folder}/${crypto.randomUUID()}.jpg`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET_NAME)
    .upload(fileName, blob, {
      contentType: 'image/jpeg',
      cacheControl: '31536000', // 1 year browser cache
      upsert: false
    });

  // Fail loudly rather than storing a large base64 image in the database
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from(BUCKET_NAME).getPublicUrl(fileName);
  return data.publicUrl;
}

/**
 * Process a picture for items (max 600px, quality 0.8)
 */
export async function processItemImage(source: string | Blob | File): Promise<string> {
  const resized = await resizeImage(source, 600, 600, 0.8);
  return uploadImageToStorage(resized, 'items');
}

/**
 * Process a proof photo for withdrawals (max 800px, quality 0.8)
 */
export async function processProofImage(source: string | Blob | File): Promise<string> {
  const resized = await resizeImage(source, 800, 800, 0.8);
  return uploadImageToStorage(resized, 'proofs');
}

/**
 * Process an avatar (max 128px, quality 0.8)
 */
export async function processAvatarImage(source: string | Blob | File): Promise<string> {
  const resized = await resizeImage(source, 128, 128, 0.8);
  return uploadImageToStorage(resized, 'avatars');
}

/**
 * One-time migration function that finds all base64 data URLs in items, transactions, and users,
 * uploads them one-by-one to Supabase Storage, and updates the rows in Supabase.
 */
export async function migrateAllBase64ToStorage(
  onProgress?: (info: { current: number; total: number; message: string }) => void
): Promise<{ migratedItems: number; migratedTransactions: number; migratedUsers: number; failed: number }> {
  if (!isSupabaseConfigured) {
    throw new Error('Supabase is not configured. Migration requires an active Supabase connection.');
  }

  let migratedItems = 0;
  let migratedTransactions = 0;
  let migratedUsers = 0;
  let failed = 0;

  // 1. Fetch items with data: pictureUrl
  onProgress?.({ current: 0, total: 0, message: 'Scanning items with embedded base64 photos...' });
  const { data: rawItems, error: itemsErr } = await supabase
    .from('items')
    .select('id, pictureUrl')
    .like('pictureUrl', 'data:%');

  const itemsToMigrate = (!itemsErr && rawItems) ? rawItems : [];

  // 2. Fetch users with data: avatarUrl
  onProgress?.({ current: 0, total: 0, message: 'Scanning users with embedded base64 avatars...' });
  const { data: rawUsers, error: usersErr } = await supabase
    .from('users')
    .select('id, avatarUrl')
    .like('avatarUrl', 'data:%');

  const usersToMigrate = (!usersErr && rawUsers) ? rawUsers : [];

  // 3. Fetch transactions with data: pictureUrl (limited to 500 at a time to prevent memory blowup)
  onProgress?.({ current: 0, total: 0, message: 'Scanning transactions with embedded proof photos...' });
  const { data: rawTxs, error: txsErr } = await supabase
    .from('transactions')
    .select('id, pictureUrl')
    .like('pictureUrl', 'data:%')
    .limit(500);

  const txsToMigrate = (!txsErr && rawTxs) ? rawTxs : [];

  const total = itemsToMigrate.length + usersToMigrate.length + txsToMigrate.length;
  let current = 0;

  if (total === 0) {
    onProgress?.({ current: 0, total: 0, message: 'No embedded base64 images found! Database is already clean.' });
    return { migratedItems: 0, migratedTransactions: 0, migratedUsers: 0, failed: 0 };
  }

  // Migrate Items
  for (const item of itemsToMigrate) {
    current++;
    onProgress?.({ current, total, message: `Migrating item photo (${current}/${total})...` });
    try {
      if (item.pictureUrl && item.pictureUrl.startsWith('data:')) {
        const publicUrl = await processItemImage(item.pictureUrl);
        if (publicUrl && !publicUrl.startsWith('data:')) {
          await supabase.from('items').update({ pictureUrl: publicUrl }).eq('id', item.id);
          migratedItems++;
        } else {
          failed++;
        }
      }
    } catch (e) {
      console.error(`Failed to migrate item ${item.id}`, e);
      failed++;
    }
  }

  // Migrate Users
  for (const u of usersToMigrate) {
    current++;
    onProgress?.({ current, total, message: `Migrating user avatar (${current}/${total})...` });
    try {
      if (u.avatarUrl && u.avatarUrl.startsWith('data:')) {
        const publicUrl = await processAvatarImage(u.avatarUrl);
        if (publicUrl && !publicUrl.startsWith('data:')) {
          await supabase.from('users').update({ avatarUrl: publicUrl }).eq('id', u.id);
          migratedUsers++;
        } else {
          failed++;
        }
      }
    } catch (e) {
      console.error(`Failed to migrate user ${u.id}`, e);
      failed++;
    }
  }

  // Migrate Transactions
  for (const t of txsToMigrate) {
    current++;
    onProgress?.({ current, total, message: `Migrating transaction proof photo (${current}/${total})...` });
    try {
      if (t.pictureUrl && t.pictureUrl.startsWith('data:')) {
        const publicUrl = await processProofImage(t.pictureUrl);
        if (publicUrl && !publicUrl.startsWith('data:')) {
          await supabase.from('transactions').update({ pictureUrl: publicUrl }).eq('id', t.id);
          migratedTransactions++;
        } else {
          failed++;
        }
      }
    } catch (e) {
      console.error(`Failed to migrate transaction ${t.id}`, e);
      failed++;
    }
  }

  onProgress?.({ current: total, total, message: `Completed! Migrated ${migratedItems + migratedTransactions + migratedUsers} images.` });

  return { migratedItems, migratedTransactions, migratedUsers, failed };
}

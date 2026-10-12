-- ==============================================================================
-- KANBAN INVENTORY RACK: COMPLETE MIGRATION SCRIPT TO MAKE THE APP FULLY ONLINE
-- Run this in your Supabase Project: Dashboard -> SQL Editor -> New query -> Run
-- Idempotent & safe to run multiple times. Order is strictly preserved.
-- ==============================================================================

-- 1. Enable pgcrypto extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Create users table if it does not exist
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Operator',
  theme TEXT NOT NULL DEFAULT 'dark',
  "avatarUrl" TEXT,
  settings JSONB NOT NULL DEFAULT '{"notificationMethod": "none", "alertThreshold": 150}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Ensure all columns exist on users for existing databases
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'dark';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{"notificationMethod": "none", "alertThreshold": 150}'::jsonb;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 4. Create items table if it does not exist
CREATE TABLE IF NOT EXISTS public.items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  "securityLimit" INTEGER NOT NULL DEFAULT 0,
  "pictureUrl" TEXT,
  "order" INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Ensure all columns exist on items for existing databases
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS "securityLimit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS "pictureUrl" TEXT;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS "order" INTEGER DEFAULT 0;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 6. Migrate any lowercase columns on items to camelCase if they exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='items' AND column_name='securitylimit') THEN
    UPDATE public.items SET "securityLimit" = securitylimit WHERE ("securityLimit" = 0 OR "securityLimit" IS NULL) AND securitylimit IS NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='items' AND column_name='pictureurl') THEN
    UPDATE public.items SET "pictureUrl" = pictureurl WHERE "pictureUrl" IS NULL AND pictureurl IS NOT NULL;
  END IF;
END $$;

-- 7. Create transactions table if it does not exist
CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "itemId" UUID NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  "poNumber" TEXT,
  "pictureUrl" TEXT,
  date BIGINT NOT NULL,
  "userId" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL
);

-- 8. Ensure all columns exist on transactions for existing databases
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS "poNumber" TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS "pictureUrl" TEXT;

-- 9. Auto-update trigger function for updated_at timestamps
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 10. Attach auto-update trigger to items table
DROP TRIGGER IF EXISTS trigger_items_updated_at ON public.items;
CREATE TRIGGER trigger_items_updated_at
BEFORE UPDATE ON public.items
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 11. Attach auto-update trigger to users table
DROP TRIGGER IF EXISTS trigger_users_updated_at ON public.users;
CREATE TRIGGER trigger_users_updated_at
BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 12. Create performance & egress optimization indexes
CREATE INDEX IF NOT EXISTS idx_transactions_item_id ON public.transactions("itemId");
CREATE INDEX IF NOT EXISTS idx_transactions_date ON public.transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions("userId");
CREATE INDEX IF NOT EXISTS idx_items_order ON public.items("order" ASC);
CREATE INDEX IF NOT EXISTS idx_items_updated_at ON public.items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_username ON public.users(username);

-- 13. Ensure supabase_realtime publication exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- 14. Configure realtime publication: stream items ONLY (drop users and transactions to eliminate egress waste)
DO $$
BEGIN
  -- Drop users from realtime publication if present
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'users'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.users;
  END IF;

  -- Drop transactions from realtime publication if present
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'transactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.transactions;
  END IF;

  -- Add items to realtime publication so all users see changes live
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.items;
  END IF;
END $$;

-- 15. Enable Row Level Security (RLS) on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- 16. Remove any conflicting legacy policies
DROP POLICY IF EXISTS "Allow all on users" ON public.users;
DROP POLICY IF EXISTS "Allow all on items" ON public.items;
DROP POLICY IF EXISTS "Allow all on transactions" ON public.transactions;

-- 17. Create permissive RLS policies for anon and authenticated clients
CREATE POLICY "Allow all on users" 
ON public.users FOR ALL TO anon, authenticated 
USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on items" 
ON public.items FOR ALL TO anon, authenticated 
USING (true) WITH CHECK (true);

CREATE POLICY "Allow all on transactions" 
ON public.transactions FOR ALL TO anon, authenticated 
USING (true) WITH CHECK (true);

-- 18. Grant schema and table permissions to anon and authenticated roles
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;

-- 19. Ensure public storage bucket 'kanban-images' exists
INSERT INTO storage.buckets (id, name, public)
VALUES ('kanban-images', 'kanban-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 20. Clean up legacy storage policies for kanban-images
DROP POLICY IF EXISTS "Public image access" ON storage.objects;
DROP POLICY IF EXISTS "Allow uploads to kanban-images" ON storage.objects;
DROP POLICY IF EXISTS "Allow updates to kanban-images" ON storage.objects;
DROP POLICY IF EXISTS "Allow deletes on kanban-images" ON storage.objects;

-- 21. Create storage RLS policies for kanban-images
CREATE POLICY "Public image access" 
ON storage.objects FOR SELECT TO anon, authenticated 
USING (bucket_id = 'kanban-images');

CREATE POLICY "Allow uploads to kanban-images" 
ON storage.objects FOR INSERT TO anon, authenticated 
WITH CHECK (bucket_id = 'kanban-images');

CREATE POLICY "Allow updates to kanban-images" 
ON storage.objects FOR UPDATE TO anon, authenticated 
USING (bucket_id = 'kanban-images') WITH CHECK (bucket_id = 'kanban-images');

CREATE POLICY "Allow deletes on kanban-images" 
ON storage.objects FOR DELETE TO anon, authenticated 
USING (bucket_id = 'kanban-images');

-- 22. Atomic stock adjustment & transaction creation function
CREATE OR REPLACE FUNCTION public.adjust_stock(item_id UUID, delta INT, tx JSONB DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
  v_new_quantity INT;
  v_tx_id UUID;
BEGIN
  -- Atomically adjust quantity (floor at 0) and update timestamp
  UPDATE public.items
  SET quantity = GREATEST(0, quantity + delta),
      updated_at = now()
  WHERE id = item_id
  RETURNING quantity INTO v_new_quantity;

  -- Create corresponding transaction if transaction payload provided
  IF tx IS NOT NULL THEN
    v_tx_id := COALESCE((tx->>'id')::uuid, gen_random_uuid());
    INSERT INTO public.transactions (
      id, "itemId", reference, type, reason, quantity, "poNumber", "pictureUrl", date, "userId", username
    ) VALUES (
      v_tx_id,
      item_id,
      COALESCE(tx->>'reference', ''),
      COALESCE(tx->>'type', CASE WHEN delta < 0 THEN 'REMOVE' ELSE 'ADD' END),
      tx->>'reason',
      COALESCE((tx->>'quantity')::int, ABS(delta)),
      tx->>'poNumber',
      tx->>'pictureUrl',
      COALESCE((tx->>'date')::bigint, (EXTRACT(EPOCH FROM now()) * 1000)::bigint),
      (tx->>'userId')::uuid,
      COALESCE(tx->>'username', 'Anonymous')
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'itemId', item_id,
    'newQuantity', v_new_quantity,
    'transactionId', v_tx_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 23. Atomic bulk stock adjustment function for batch takes
CREATE OR REPLACE FUNCTION public.adjust_stock_bulk(operations JSONB)
RETURNS JSONB AS $$
DECLARE
  op JSONB;
  v_item_id UUID;
  v_delta INT;
  v_tx JSONB;
  v_results JSONB := '[]'::jsonb;
  v_res JSONB;
BEGIN
  FOR op IN SELECT * FROM jsonb_array_elements(operations)
  LOOP
    v_item_id := (op->>'itemId')::uuid;
    v_delta := (op->>'delta')::int;
    v_tx := op->'tx';
    v_res := public.adjust_stock(v_item_id, v_delta, v_tx);
    v_results := v_results || v_res;
  END LOOP;
  RETURN v_results;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 24. Grant execution permissions for adjust_stock functions
GRANT EXECUTE ON FUNCTION public.adjust_stock(UUID, INT, JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.adjust_stock_bulk(JSONB) TO anon, authenticated, service_role;

-- 25. Seed default admin user (admin / 121) for instant login
INSERT INTO public.users (id, username, password, role, theme, settings)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'admin',
  '121',
  'Admin',
  'dark',
  '{"notificationMethod": "none", "alertThreshold": 150}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

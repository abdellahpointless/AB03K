-- ==============================================================================
-- KANBAN INVENTORY RACK: SUPABASE SCHEMA, SECURITY & MIGRATION
--
-- Run this whole file in Supabase: Dashboard > SQL Editor > New query > Run.
-- It is idempotent: it creates a fresh database, and it upgrades a database
-- created by the old supabase_schema.sql / supabase_migrations.sql in place.
--
-- What the upgrade does to existing data:
--   * Every row in public.users gets a matching Supabase Auth account with the
--     SAME id, so existing transactions keep pointing at the right user.
--     Usernames and passwords keep working; passwords are bcrypt-hashed by
--     Supabase Auth and the plain-text password column is dropped.
--   * Row Level Security now checks the signed-in user's role in the database,
--     instead of letting anyone holding the public anon key read and write
--     everything.
--
-- Deploy order: run this script FIRST, then deploy the new frontend.
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ------------------------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'Operator',
  theme TEXT NOT NULL DEFAULT 'dark',
  "avatarUrl" TEXT,
  settings JSONB NOT NULL DEFAULT '{"notificationMethod": "none", "alertThreshold": 150}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'dark';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{"notificationMethod": "none", "alertThreshold": 150}'::jsonb;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE TABLE IF NOT EXISTS public.items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  "securityLimit" INTEGER NOT NULL DEFAULT 0,
  "pictureUrl" TEXT,
  "order" INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS "securityLimit" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS "pictureUrl" TEXT;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS "order" INTEGER DEFAULT 0;
ALTER TABLE public.items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Migrate lowercase legacy columns to camelCase if they exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='items' AND column_name='securitylimit') THEN
    EXECUTE 'UPDATE public.items SET "securityLimit" = securitylimit WHERE ("securityLimit" = 0 OR "securityLimit" IS NULL) AND securitylimit IS NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='items' AND column_name='pictureurl') THEN
    EXECUTE 'UPDATE public.items SET "pictureUrl" = pictureurl WHERE "pictureUrl" IS NULL AND pictureurl IS NOT NULL';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "itemId" UUID REFERENCES public.items(id) ON DELETE SET NULL,
  reference TEXT NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  "poNumber" TEXT,
  "pictureUrl" TEXT,
  date BIGINT NOT NULL,
  "userId" UUID REFERENCES public.users(id) ON DELETE SET NULL,
  username TEXT NOT NULL
);
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS "poNumber" TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS "pictureUrl" TEXT;

-- Deleting a box or a user used to CASCADE and silently wipe its whole
-- transaction history. Keep the history instead (reference/username are
-- stored on each transaction row).
ALTER TABLE public.transactions ALTER COLUMN "itemId" DROP NOT NULL;
ALTER TABLE public.transactions ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS "transactions_itemId_fkey";
ALTER TABLE public.transactions ADD CONSTRAINT "transactions_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES public.items(id) ON DELETE SET NULL;
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS "transactions_userId_fkey";
ALTER TABLE public.transactions ADD CONSTRAINT "transactions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES public.users(id) ON DELETE SET NULL;

-- Shared app settings (picture framing). Previously only saved in one browser.
CREATE TABLE IF NOT EXISTS public.app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  "picturePosition" TEXT NOT NULL DEFAULT '50% 50%',
  "pictureScale" REAL NOT NULL DEFAULT 1.0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 2. Constraints (added NOT VALID so old rows never block the migration)
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_role_check
      CHECK (role IN ('Admin', 'Manager', 'Operator', 'Warehouse', 'Overview')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_quantity_check') THEN
    ALTER TABLE public.items ADD CONSTRAINT items_quantity_check CHECK (quantity >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_type_check') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check
      CHECK (type IN ('ADD', 'REMOVE')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_quantity_check') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_quantity_check CHECK (quantity > 0) NOT VALID;
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 3. updated_at triggers and indexes
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = '';

DROP TRIGGER IF EXISTS trigger_items_updated_at ON public.items;
CREATE TRIGGER trigger_items_updated_at BEFORE UPDATE ON public.items
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trigger_users_updated_at ON public.users;
CREATE TRIGGER trigger_users_updated_at BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE INDEX IF NOT EXISTS idx_transactions_item_id ON public.transactions("itemId");
CREATE INDEX IF NOT EXISTS idx_transactions_date ON public.transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON public.transactions("userId");
CREATE INDEX IF NOT EXISTS idx_items_order ON public.items("order" ASC);
CREATE INDEX IF NOT EXISTS idx_items_updated_at ON public.items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_username ON public.users(username);

-- ------------------------------------------------------------------------------
-- 4. Auth helpers
-- ------------------------------------------------------------------------------
-- Usernames are mapped to an internal e-mail for Supabase Auth. The frontend
-- computes the same value (see usernameToEmail in src/socket.ts).
CREATE OR REPLACE FUNCTION public.username_to_email(p_username TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT substr(encode(extensions.digest(lower(trim(p_username)), 'sha256'), 'hex'), 1, 32) || '@kanban.local';
$$;

-- Role of the signed-in user, or NULL when not signed in.
CREATE OR REPLACE FUNCTION public.app_role()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT role FROM public.users WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.app_has_role(VARIADIC p_roles TEXT[])
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((SELECT role FROM public.users WHERE id = auth.uid()) = ANY (p_roles), false);
$$;

-- Creates (or re-syncs) the Supabase Auth account for a profile row.
-- Internal: only called by the migration below and by admin_create_user.
CREATE OR REPLACE FUNCTION public._upsert_auth_user(p_id UUID, p_username TEXT, p_password TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email TEXT := public.username_to_email(p_username);
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = p_id) THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = v_email) THEN
    RAISE EXCEPTION 'Username "%" is already taken', p_username USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    jsonb_build_object('username', p_username), now(), now(),
    '', '', '', ''
  );

  INSERT INTO auth.identities (
    id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), p_id::text, p_id,
    jsonb_build_object('sub', p_id::text, 'email', v_email, 'email_verified', true),
    'email', now(), now(), now()
  );
END;
$$;
REVOKE ALL ON FUNCTION public._upsert_auth_user(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 5. One-time migration of plain-text passwords into Supabase Auth
-- ------------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'password') THEN
    FOR r IN EXECUTE 'SELECT id, username, password FROM public.users ORDER BY username' LOOP
      BEGIN
        PERFORM public._upsert_auth_user(r.id, r.username, COALESCE(r.password, ''));
      EXCEPTION WHEN unique_violation THEN
        RAISE WARNING 'Skipped user % (%): another user has the same username (usernames are now case-insensitive). Rename it and re-run.', r.username, r.id;
      END;
    END LOOP;
    -- Only drop the plain-text column once every user has an auth account.
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id)) THEN
      ALTER TABLE public.users DROP COLUMN password;
    ELSE
      RAISE WARNING 'Some users could not be migrated, so the password column was kept. Fix the warnings above and run this script again.';
    END IF;
  END IF;
END $$;

-- Fresh install: create the first admin so someone can sign in.
-- CHANGE THIS PASSWORD right after the first sign-in (Admin > Users > Edit).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users) THEN
    INSERT INTO public.users (id, username, role, theme)
    VALUES ('00000000-0000-0000-0000-000000000001', 'admin', 'Admin', 'dark');
    PERFORM public._upsert_auth_user('00000000-0000-0000-0000-000000000001', 'admin', '121');
  END IF;
END $$;

-- Keep profiles and auth accounts in sync: deleting a profile deletes its login.
CREATE OR REPLACE FUNCTION public.handle_profile_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM auth.users WHERE id = OLD.id;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS trigger_users_delete_auth ON public.users;
CREATE TRIGGER trigger_users_delete_auth AFTER DELETE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.handle_profile_deleted();

-- Non-admins may edit their own theme/avatar/settings, but never their
-- username or role.
CREATE OR REPLACE FUNCTION public.guard_user_update()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.app_has_role('Admin') THEN
    RETURN NEW;
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.username IS DISTINCT FROM OLD.username OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Only an Admin can change usernames or roles' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trigger_users_guard ON public.users;
CREATE TRIGGER trigger_users_guard BEFORE UPDATE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.guard_user_update();

-- ------------------------------------------------------------------------------
-- 6. Admin user management (runs with elevated rights, checks caller is Admin)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_user(p_username TEXT, p_password TEXT, p_role TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  IF NOT public.app_has_role('Admin') THEN
    RAISE EXCEPTION 'Only an Admin can create users' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF length(trim(COALESCE(p_username, ''))) = 0 OR length(COALESCE(p_password, '')) = 0 THEN
    RAISE EXCEPTION 'Username and password are required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE lower(username) = lower(trim(p_username))) THEN
    RAISE EXCEPTION 'Username "%" is already taken', trim(p_username) USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO public.users (id, username, role) VALUES (v_id, trim(p_username), p_role);
  PERFORM public._upsert_auth_user(v_id, trim(p_username), p_password);
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_user(p_user_id UUID, p_username TEXT, p_role TEXT, p_password TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_username TEXT := trim(p_username);
BEGIN
  IF NOT public.app_has_role('Admin') THEN
    RAISE EXCEPTION 'Only an Admin can edit users' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_id = auth.uid() AND p_role IS DISTINCT FROM 'Admin' THEN
    RAISE EXCEPTION 'You cannot remove your own Admin role';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users WHERE lower(username) = lower(v_username) AND id <> p_user_id) THEN
    RAISE EXCEPTION 'Username "%" is already taken', v_username USING ERRCODE = 'unique_violation';
  END IF;

  UPDATE public.users SET username = v_username, role = p_role WHERE id = p_user_id;
  UPDATE auth.users
     SET email = public.username_to_email(v_username),
         raw_user_meta_data = jsonb_build_object('username', v_username),
         encrypted_password = CASE WHEN COALESCE(p_password, '') <> ''
                                   THEN extensions.crypt(p_password, extensions.gen_salt('bf'))
                                   ELSE encrypted_password END,
         updated_at = now()
   WHERE id = p_user_id;
  UPDATE auth.identities
     SET identity_data = identity_data || jsonb_build_object('email', public.username_to_email(v_username)),
         updated_at = now()
   WHERE user_id = p_user_id AND provider = 'email';
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_user(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.app_has_role('Admin') THEN
    RAISE EXCEPTION 'Only an Admin can delete users' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot delete your own account';
  END IF;
  DELETE FROM public.users WHERE id = p_user_id;
END;
$$;

-- ------------------------------------------------------------------------------
-- 7. Stock changes: atomic, role-checked, and always logged
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.adjust_stock(UUID, INT, JSONB);
CREATE OR REPLACE FUNCTION public.adjust_stock(item_id UUID, delta INT, tx JSONB DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role TEXT := public.app_role();
  v_item public.items%ROWTYPE;
  v_new_quantity INT;
  v_tx_id UUID;
  v_username TEXT;
BEGIN
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF delta = 0 THEN
    RAISE EXCEPTION 'Quantity change must not be zero';
  END IF;
  IF delta < 0 AND v_role NOT IN ('Admin', 'Manager', 'Operator') THEN
    RAISE EXCEPTION 'Your role (%) cannot take items', v_role USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF delta > 0 AND v_role NOT IN ('Admin', 'Manager', 'Warehouse') THEN
    RAISE EXCEPTION 'Your role (%) cannot add stock', v_role USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_item FROM public.items WHERE id = item_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Box not found';
  END IF;
  IF v_item.quantity + delta < 0 THEN
    RAISE EXCEPTION 'Only % left of %', v_item.quantity, v_item.reference;
  END IF;

  UPDATE public.items SET quantity = quantity + delta WHERE id = item_id
  RETURNING quantity INTO v_new_quantity;

  SELECT username INTO v_username FROM public.users WHERE id = auth.uid();
  v_tx_id := COALESCE(NULLIF(tx->>'id', '')::uuid, gen_random_uuid());
  INSERT INTO public.transactions (
    id, "itemId", reference, type, reason, quantity, "poNumber", "pictureUrl", date, "userId", username
  ) VALUES (
    v_tx_id,
    item_id,
    v_item.reference,
    CASE WHEN delta < 0 THEN 'REMOVE' ELSE 'ADD' END,
    NULLIF(tx->>'reason', ''),
    abs(delta),
    NULLIF(tx->>'poNumber', ''),
    NULLIF(tx->>'pictureUrl', ''),
    (extract(epoch FROM now()) * 1000)::bigint,
    auth.uid(),
    v_username
  );

  RETURN jsonb_build_object('itemId', item_id, 'newQuantity', v_new_quantity, 'transactionId', v_tx_id);
END;
$$;

-- All-or-nothing: if any box lacks stock, nothing is taken.
CREATE OR REPLACE FUNCTION public.adjust_stock_bulk(operations JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  op JSONB;
  v_results JSONB := '[]'::jsonb;
BEGIN
  FOR op IN SELECT * FROM jsonb_array_elements(operations) LOOP
    v_results := v_results || jsonb_build_array(
      public.adjust_stock((op->>'itemId')::uuid, (op->>'delta')::int, op->'tx')
    );
  END LOOP;
  RETURN v_results;
END;
$$;

-- Undo: reverses a stock movement and removes its log entry.
-- Allowed for the person who made it (within 10 minutes) or an Admin.
CREATE OR REPLACE FUNCTION public.undo_transaction(p_tx_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_new_quantity INT;
BEGIN
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found';
  END IF;
  IF NOT (public.app_has_role('Admin')
          OR (v_tx."userId" = auth.uid() AND v_tx.date > (extract(epoch FROM now()) * 1000)::bigint - 600000)) THEN
    RAISE EXCEPTION 'This transaction can no longer be undone' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_tx."itemId" IS NOT NULL THEN
    UPDATE public.items
       SET quantity = GREATEST(0, quantity + CASE WHEN v_tx.type = 'REMOVE' THEN v_tx.quantity ELSE -v_tx.quantity END)
     WHERE id = v_tx."itemId"
    RETURNING quantity INTO v_new_quantity;
  END IF;
  DELETE FROM public.transactions WHERE id = p_tx_id;

  RETURN jsonb_build_object('itemId', v_tx."itemId", 'newQuantity', v_new_quantity);
END;
$$;

-- Reorder in one call (the old client-side upsert failed on NOT NULL columns).
CREATE OR REPLACE FUNCTION public.reorder_items(updates JSONB)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.app_has_role('Admin', 'Manager') THEN
    RAISE EXCEPTION 'Only an Admin or Manager can reorder boxes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.items i
     SET "order" = (u->>'order')::int
    FROM jsonb_array_elements(updates) AS u
   WHERE i.id = (u->>'id')::uuid;
END;
$$;

-- ------------------------------------------------------------------------------
-- 8. Row Level Security
-- ------------------------------------------------------------------------------
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Remove the old "anyone can do anything" policies
DROP POLICY IF EXISTS "Allow all on users" ON public.users;
DROP POLICY IF EXISTS "Allow all on items" ON public.items;
DROP POLICY IF EXISTS "Allow all on transactions" ON public.transactions;

DROP POLICY IF EXISTS "users_select" ON public.users;
DROP POLICY IF EXISTS "users_update" ON public.users;
CREATE POLICY "users_select" ON public.users FOR SELECT TO authenticated USING (true);
CREATE POLICY "users_update" ON public.users FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.app_has_role('Admin'))
  WITH CHECK (id = auth.uid() OR public.app_has_role('Admin'));
-- Inserts and deletes go through admin_create_user / admin_delete_user.

DROP POLICY IF EXISTS "items_select" ON public.items;
DROP POLICY IF EXISTS "items_insert" ON public.items;
DROP POLICY IF EXISTS "items_update" ON public.items;
DROP POLICY IF EXISTS "items_delete" ON public.items;
CREATE POLICY "items_select" ON public.items FOR SELECT TO authenticated USING (true);
CREATE POLICY "items_insert" ON public.items FOR INSERT TO authenticated
  WITH CHECK (public.app_has_role('Admin', 'Manager'));
CREATE POLICY "items_update" ON public.items FOR UPDATE TO authenticated
  USING (public.app_has_role('Admin', 'Manager'))
  WITH CHECK (public.app_has_role('Admin', 'Manager'));
CREATE POLICY "items_delete" ON public.items FOR DELETE TO authenticated
  USING (public.app_has_role('Admin', 'Manager'));

-- Transactions are written only by adjust_stock / undo_transaction. Admins may
-- update the picture column (used by the "move images to Storage" tool).
DROP POLICY IF EXISTS "transactions_select" ON public.transactions;
DROP POLICY IF EXISTS "transactions_update_picture" ON public.transactions;
CREATE POLICY "transactions_select" ON public.transactions FOR SELECT TO authenticated USING (true);
CREATE POLICY "transactions_update_picture" ON public.transactions FOR UPDATE TO authenticated
  USING (public.app_has_role('Admin'))
  WITH CHECK (public.app_has_role('Admin'));

DROP POLICY IF EXISTS "app_settings_select" ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_update" ON public.app_settings;
CREATE POLICY "app_settings_select" ON public.app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "app_settings_update" ON public.app_settings FOR UPDATE TO authenticated
  USING (public.app_has_role('Admin', 'Manager'))
  WITH CHECK (public.app_has_role('Admin', 'Manager'));

-- ------------------------------------------------------------------------------
-- 9. Grants: nothing for anonymous visitors
-- ------------------------------------------------------------------------------
REVOKE ALL ON public.users, public.items, public.transactions, public.app_settings FROM anon;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
REVOKE ALL ON public.users, public.items, public.app_settings FROM authenticated;
GRANT SELECT, UPDATE ON public.users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.items TO authenticated;
REVOKE ALL ON public.transactions FROM authenticated;
GRANT SELECT ON public.transactions TO authenticated;
GRANT UPDATE ("pictureUrl") ON public.transactions TO authenticated;
GRANT SELECT, UPDATE ON public.app_settings TO authenticated;
GRANT ALL ON public.users, public.items, public.transactions, public.app_settings TO service_role;

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.adjust_stock(uuid, integer, jsonb)',
    'public.adjust_stock_bulk(jsonb)',
    'public.undo_transaction(uuid)',
    'public.reorder_items(jsonb)',
    'public.admin_create_user(text, text, text)',
    'public.admin_update_user(uuid, text, text, text)',
    'public.admin_delete_user(uuid)',
    'public.app_role()',
    'public.app_has_role(text[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.handle_profile_deleted() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_user_update() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------------------
-- 10. Realtime: stream items and shared settings only
-- ------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'users') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.users;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'transactions') THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.transactions;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'items') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.items;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'app_settings') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.app_settings;
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 11. Storage bucket for pictures: public read, signed-in upload only
-- ------------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('kanban-images', 'kanban-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "Public image access" ON storage.objects;
DROP POLICY IF EXISTS "Allow uploads to kanban-images" ON storage.objects;
DROP POLICY IF EXISTS "Allow updates to kanban-images" ON storage.objects;
DROP POLICY IF EXISTS "Allow deletes on kanban-images" ON storage.objects;

CREATE POLICY "Public image access" ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'kanban-images');
CREATE POLICY "Allow uploads to kanban-images" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'kanban-images');
CREATE POLICY "Allow updates to kanban-images" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'kanban-images' AND public.app_has_role('Admin', 'Manager'))
  WITH CHECK (bucket_id = 'kanban-images');
CREATE POLICY "Allow deletes on kanban-images" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'kanban-images' AND public.app_has_role('Admin', 'Manager'));

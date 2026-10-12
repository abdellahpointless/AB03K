# Kanban Inventory Rack

A kanban rack for warehouse stock: each box shows its quantity, glows when it
nears or hits its security limit, and every take or restock is logged with who
did it. Admins and managers get a dashboard, transaction history, Excel/CSV
exports and user management.

It is a static React + Vite site (hosted on Netlify) that talks directly to
Supabase for sign-in, data, realtime updates and picture storage.

## Roles

| Role      | Take items | Add stock | Edit / add / delete boxes | Admin console | Manage users |
|-----------|:---:|:---:|:---:|:---:|:---:|
| Admin     | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manager   | ✓ | ✓ | ✓ | ✓ |   |
| Operator  | ✓ |   |   |   |   |
| Warehouse |   | ✓ |   |   |   |
| Overview  |   |   |   |   |   |

These rules are enforced by the database (Row Level Security and the
functions in `supabase/schema.sql`), not just hidden in the UI.

## Set up Supabase

1. Open your project's **SQL Editor**, paste all of
   [`supabase/schema.sql`](supabase/schema.sql) and run it. The script is safe
   to run more than once.
   - On an **existing** database from the earlier version of this app it
     moves every user to Supabase Auth with the same username and password,
     hashes the passwords and drops the plain-text password column. Check the
     output for warnings about duplicate usernames (usernames are now
     case-insensitive).
   - On an **empty** database it creates a first user `admin` with password
     `121`. Sign in and change that password straight away
     (Admin console > Users > Edit).
2. Copy the **Project URL** and **anon public key** from
   Project Settings > API.

Run the SQL **before** deploying this version of the frontend: the new
frontend signs in through Supabase Auth, and the old frontend stops working
once the script has run.

## Deploy on Netlify

`netlify.toml` already sets the build command (`npm run build`) and publish
folder (`dist`). Under Site configuration > Environment variables, set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

then trigger a deploy. Variables are baked in at build time, so redeploy after
changing them.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env.local   # fill in the two Supabase values
npm run dev
```

Without Supabase values the app runs in **offline mode**: everything is stored
in that browser only, and the first sign-in with `admin` / `121` creates the
admin account.

Other scripts: `npm run build`, `npm run preview`, `npm run lint` (type check).

## Notes

- Weekly Excel archives are generated in the browser and kept in that
  browser's storage; use "Export Excel" for a full export at any time.
- E-mail alerts in user settings are a placeholder: the app shows a pop-up
  instead of sending mail.

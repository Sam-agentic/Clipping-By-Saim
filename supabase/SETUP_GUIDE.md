# Clipping by Saim — Complete Supabase Setup Guide

This guide walks through the **full backend setup** for the licensing system:
database schema, owner profile bootstrap, Edge Functions, secrets, and the
desktop app config. Follow the steps **in order**.

---

## Prerequisites

- A **Supabase account** (free tier is fine) — create one at https://supabase.com
- **Supabase CLI** installed:
  ```bash
  npm install -g supabase
  ```
  Verify with `supabase --version`.
- Node.js 18+ (for the desktop app itself).

---

## Step 1 — Create the Supabase project

1. Go to https://supabase.com/dashboard → **New project**.
2. Choose a name, e.g. `clipping-by-saim`.
3. Set a strong database password and save it somewhere safe.
4. Pick a region close to your customers.
5. Wait for the project to finish provisioning (1–2 minutes).

> ⚠️ **Only you** should have access to this project. Do not share the
> dashboard login or the service-role key.

---

## Step 2 — Run the database schema

1. In the Supabase Dashboard, open **SQL Editor** → **New query**.
2. Copy the entire contents of [`schema.sql`](schema.sql) and paste it in.
3. Click **Run**.

This creates four tables:

| Table | Purpose |
|---|---|
| `profiles` | One row per user: role (`owner`/`customer`), status (`pending`/`active`/`revoked`), device limit, `updated_at` |
| `access_requests` | Pending requests from the app's "Request Access" screen |
| `licensed_devices` | Tracks which device hashes are allowed per user |
| `free_trials` | One-trial-per-device claims (unique `device_hash`, `expires_at`) for the server-side 7-day trial |

All four tables have **Row Level Security enabled** with no direct client
policies — all access goes through Edge Functions using the service role.

`schema.sql` also installs a `touch_updated_at` trigger so `profiles.updated_at`
is kept fresh automatically whenever a profile row changes.

---

## Step 3 — Create your owner Auth user

1. In the Dashboard, go to **Authentication → Users → Add user**.
2. Create a user with email **`saimabdullah310@gmail.com`** and a strong
   password. (This is the owner account.)
3. Do **not** enable public sign-ups. Go to **Authentication → Providers →
   Email** and turn off "Allow new users to sign up".

---

## Step 4 — Bootstrap the owner profile

1. Open **SQL Editor** → **New query**.
2. Copy the entire contents of [`owner-bootstrap.sql`](owner-bootstrap.sql).
3. Click **Run**.

This does four things:

1. Installs a **trigger** (`handle_new_user`) that automatically creates a
   `profiles` row whenever a new Auth user is created — so you never have to
   insert profiles manually for invited customers. New profiles start with
   `status = 'pending'`, so a self-registered user is **not** automatically
   licensed: you must approve the account (set `status = 'active'`) before
   their sign-in unlocks the app.
2. Installs the **`touch_updated_at` trigger** on `profiles` (same as
   `schema.sql`, kept here so a fresh project can run only this file).
3. Inserts/updates the owner profile for `saimabdullah310@gmail.com` with
   `role = 'owner'`, `status = 'active'`, `device_limit = 10`.
4. Leaves a commented-out snippet in case you ever change the owner email.

> ✅ **Verify:** Run this query in the SQL editor:
> ```sql
> select id, email, role, status, device_limit from public.profiles;
> ```
> You should see exactly one row with `role = 'owner'`.

> 🧪 **Full setup check:** After completing Steps 2–4, run
> [`verify-setup.sql`](verify-setup.sql) in the SQL Editor. It returns a
> PASS/FAIL row for every table, trigger, RLS setting, and the owner profile.
> Fix anything that shows FAIL before continuing.

---

## Step 5 — Deploy the Edge Functions

The seven functions live in [`functions/`](functions/):

| Function | Purpose |
|---|---|
| `request-access` | Public — lets a customer submit their email for approval |
| `verify-license` | Public — checks JWT + device hash against `profiles`/`licensed_devices` |
| `trial-claim` | Public — one-trial-per-device server-side claim (7-day window, idempotent) |
| `admin-approve` | Owner-only — invites a customer and creates their profile |
| `admin-list-requests` | Owner-only — lists pending access requests |
| `admin-revoke` | Owner-only — sets a customer's status to `active` or `revoked` |
| `admin-list-customers` | Owner-only — lists all profiles with status/device limits |

### 5a. Link your project

From the `video-editor/supabase` directory:

```bash
cd video-editor/supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

> Your project ref is the part of your project URL before `.supabase.co`,
> e.g. `hnophogpnlybkwwdemvn` in
> `https://hnophogpnlybkwwdemvn.supabase.co`.

### 5b. Deploy

```bash
supabase functions deploy request-access
supabase functions deploy verify-license
supabase functions deploy trial-claim
supabase functions deploy admin-approve
supabase functions deploy admin-list-requests
supabase functions deploy admin-revoke
supabase functions deploy admin-list-customers
```

Or deploy all at once:

```bash
supabase functions deploy
```

The [`config.toml`](config.toml) already sets `verify_jwt = false` for all
seven functions, because the functions validate the JWT themselves (or don't
need one, in the case of `request-access` and `trial-claim`).

---

## Step 6 — Set the service-role secret

Each function uses `SUPABASE_SERVICE_ROLE_KEY` from its environment. Set it
once per function:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

> Where do I find the service-role key?
> Dashboard → **Project Settings → API** → under "Project API keys" →
> `service_role` (the secret one, **not** the anon key).

> ⚠️ **Never** put this key in `licensing.config.json`, in Git, or anywhere in
> the desktop app bundle. It only ever lives as an Edge Function secret.

---

## Step 7 — Configure the desktop app

1. Copy `licensing.config.example.json` to `licensing.config.json`:
   ```bash
   cd video-editor
   copy licensing.config.example.json licensing.config.json
   ```
2. Open `licensing.config.json` and fill in your real values:

   ```json
   {
     "enforcement": "required",
     "supabaseUrl": "https://YOUR-PROJECT.supabase.co",
     "supabaseAnonKey": "YOUR-PUBLIC-ANON-KEY"
   }
   ```

   - `supabaseUrl` — your project URL (Dashboard → Project Settings → API).
   - `supabaseAnonKey` — the **anon** (publishable) key, not the service role.
   - `enforcement` — keep `"required"` for release builds. For local
     development you can delete `licensing.config.json` entirely to skip
     licensing.

> ⚠️ The anon key is public by design. Security comes from RLS + Edge
> Functions, not from hiding the anon key.

---

## Step 8 — Test the full flow

### 8a. Request access (customer side)

1. Run the app: `npm start` (with `licensing.config.json` present).
2. On the license screen, enter a test email and click **Request Access**.
3. In Supabase Dashboard → **SQL Editor**, verify the row appeared:
   ```sql
   select * from public.access_requests order by requested_at desc;
   ```

### 8b. Approve the customer (owner side)

1. In the app, sign in as `saimabdullah310@gmail.com`.
2. Use the owner approval UI (or call the function directly):
   ```bash
   curl -X POST https://YOUR-PROJECT.supabase.co/functions/v1/admin-approve \
     -H "Authorization: Bearer YOUR_OWNER_ACCESS_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"email":"customer@example.com","deviceLimit":2}'
   ```
3. Supabase sends the customer an **English invitation email**.
4. Verify in SQL:
   ```sql
   select id, email, role, status, device_limit from public.profiles;
   select * from public.access_requests;
   ```
   The customer now has a `profiles` row with `role = 'customer'` and the
   `access_requests` row has `approved_at` set.

### 8c. Sign in and verify license (customer side)

1. The customer clicks the invite link, sets a password, and signs in.
2. The app calls `verify-license` with the JWT + device hash.
3. The function checks:
   - JWT is valid → `auth.getUser(jwt)`
   - Profile exists and `status = 'active'`
   - Device count is under `device_limit`
4. On success the device is upserted into `licensed_devices` and the app
   unlocks.
### 8d. Free trial (customer side)

The app's **Free Trial** button claims a 7-day, one-trial-per-device window
through the `trial-claim` Edge Function:

1. The app sends `{ device_hash, email, app_version }` to `trial-claim`.
2. A fresh claim inserts a row into `free_trials` and returns `expires_at`.
3. A re-claim inside the window is **idempotent** and returns the *same*
   expiry — so deleting the app's local files, moving the app, or changing the
   system clock cannot restart the trial.
4. A claim after the window is **denied** (`allowed: false`).
5. While on trial, the app enforces locally: at most **3 rendered clips** per
   device and a white `Clipping by Saim` watermark **burned into every frame**
   at 35% opacity (bottom-right). Deleting local files resets the clip counter
   but never the server-side window.

> ⚠️ The trial only grants clip rendering. Sign-in, exports, and owner
> features still require an approved `profiles` row with `status = 'active'`.

---

---

## Step 9 — Managing customers

> 💡 **Daily operations:** All the queries below (plus more) are collected in
> [`owner-operations.sql`](owner-operations.sql). Open that file in the SQL
> Editor and run the section you need — no need to type them out each time.

### Revoke a customer (via Edge Function)

```bash
curl -X POST https://YOUR-PROJECT.supabase.co/functions/v1/admin-revoke \
  -H "Authorization: Bearer YOUR_OWNER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"customer@example.com","status":"revoked"}'
```

To re-activate, send `"status":"active"` instead.

### List pending access requests (via Edge Function)

```bash
curl -X POST https://YOUR-PROJECT.supabase.co/functions/v1/admin-list-requests \
  -H "Authorization: Bearer YOUR_OWNER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### List all customers (via Edge Function)

```bash
curl -X POST https://YOUR-PROJECT.supabase.co/functions/v1/admin-list-customers \
  -H "Authorization: Bearer YOUR_OWNER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Change a device limit (direct SQL)

```sql
update public.profiles set device_limit = 5 where email = 'customer@example.com';
```

### View all licensed devices

```sql
select p.email, ld.device_hash, ld.last_seen_at
from public.licensed_devices ld
join public.profiles p on p.id = ld.user_id
order by ld.last_seen_at desc;
```

### Change the owner email

```sql
insert into public.profiles (id, email, role)
select id, email, 'owner' from auth.users where email = 'owner@example.com'
on conflict (id) do update set role = 'owner';
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Owner access required.` | You're not signed in as the owner, or the owner profile doesn't have `role = 'owner'`. Re-run `owner-bootstrap.sql`. |
| `No profile found for that email.` | The email isn't in `profiles` yet. Approve the customer first via `admin-approve`. |
| `Could not find or create the customer account.` | The invite failed. Check the email is valid and that public sign-ups are disabled (invites still work). |
| `Your device limit has been reached.` | The customer has used all their devices. Increase `device_limit` or revoke old devices. |
| `Please sign in again.` | The JWT expired. The app will prompt for a fresh sign-in. |
| Functions return 404 | The functions aren't deployed, or the URL/anon key in `licensing.config.json` is wrong. |
| `Your free trial has reached its clip limit.` | That device already claimed its 7-day trial and used the 3-clip budget (or the window expired). Approve the customer's email or have them request access. |
| `The free trial for this device has already been used.` | `free_trials` has an expired row for this `device_hash`. One trial per device, ever — there is no reset from the app side. |
| Account created but sign-in stays locked | New self-registered accounts start `pending`. Set `status = 'active'` in `profiles` (approve them), or have the customer re-request access. |
| `Licensing has not been configured for this build.` | `licensing.config.json` is missing or `enforcement` isn't `"required"`. |

---

## Security checklist

- [ ] Only you have dashboard access to the Supabase project.
- [ ] Public sign-ups are **disabled**.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is only set as an Edge Function secret.
- [ ] `licensing.config.json` only contains the **anon** key.
- [ ] `licensing.config.json` is in `.gitignore` (never commit it).
- [ ] RLS is enabled on all four tables (already done in `schema.sql`).
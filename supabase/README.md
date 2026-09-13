# Clipping by Saim licensing backend

1. Create a Supabase project that only you own.
2. Run `schema.sql` in its SQL editor. It creates `profiles`, `access_requests`,
   `licensed_devices`, and `free_trials` (one-trial-per-device claims).
3. Deploy all Edge Functions in `functions/` with the Supabase CLI (including
   `trial-claim`, the server-side 7-day trial gate).
4. Put the project's **URL** and **anon key** in a copy of
   `licensing.config.example.json` named `licensing.config.json`.
5. In Supabase Authentication, disable public sign-ups. When a buyer requests
   access, review `access_requests`; then call the `admin-approve` function
   while signed in as your owner account. It creates/invites the account and
   sends the customer an English email.

Self-registered accounts are created with `status = 'pending'`, so signing up
never unlocks the app by itself — the owner must approve the profile. Until
then the user can only render 3 trial clips (with a burned-in watermark).

Never put `SUPABASE_SERVICE_ROLE_KEY` in the desktop app or in Git. Set it as
an Edge Function secret. The desktop app only contains the public anon key.

Create your own Auth user first, then run [owner-bootstrap.sql](owner-bootstrap.sql)
to make `saimabdullah310@gmail.com` the owner. If you ever change owner email,
use this equivalent SQL:

```sql
insert into public.profiles (id, email, role)
select id, email, 'owner' from auth.users where email = 'owner@example.com'
on conflict (id) do update set role = 'owner';
```

For release builds, keep `enforcement` set to `required`. During development,
leaving out `licensing.config.json` deliberately keeps the app usable locally.

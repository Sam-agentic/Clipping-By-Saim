-- ============================================================
-- Setup verification — run this to confirm everything is working
-- ============================================================
-- Run this in Supabase Dashboard → SQL Editor.
-- It returns one row per check with a PASS/FAIL status.

-- 1) Tables exist?
select
  'profiles' as check_name,
  case when to_regclass('public.profiles') is not null then 'PASS' else 'FAIL' end as status
union all
select
  'access_requests',
  case when to_regclass('public.access_requests') is not null then 'PASS' else 'FAIL' end
union all
select
  'licensed_devices',
  case when to_regclass('public.licensed_devices') is not null then 'PASS' else 'FAIL' end
union all
-- 2) Triggers installed?
select
  'handle_new_user trigger',
  case when exists (
    select 1 from pg_trigger where tgname = 'on_auth_user_created'
  ) then 'PASS' else 'FAIL' end
union all
select
  'touch_updated_at trigger',
  case when exists (
    select 1 from pg_trigger where tgname = 'profiles_touch_updated_at'
  ) then 'PASS' else 'FAIL' end
union all
-- 3) RLS enabled on all three tables?
select
  'RLS on profiles',
  case when relrowsecurity = true then 'PASS' else 'FAIL' end
from pg_class where oid = 'public.profiles'::regclass
union all
select
  'RLS on access_requests',
  case when relrowsecurity = true then 'PASS' else 'FAIL' end
from pg_class where oid = 'public.access_requests'::regclass
union all
select
  'RLS on licensed_devices',
  case when relrowsecurity = true then 'PASS' else 'FAIL' end
from pg_class where oid = 'public.licensed_devices'::regclass
union all
-- 4) Owner profile exists?
select
  'owner profile (saimabdullah310@gmail.com)',
  case when exists (
    select 1 from public.profiles
    where lower(email) = 'saimabdullah310@gmail.com' and role = 'owner'
  ) then 'PASS' else 'FAIL' end
union all
-- 5) Owner status is active?
select
  'owner status = active',
  case when exists (
    select 1 from public.profiles
    where lower(email) = 'saimabdullah310@gmail.com'
      and role = 'owner' and status = 'active'
  ) then 'PASS' else 'FAIL' end
union all
-- 6) Owner device limit is 10?
select
  'owner device_limit = 10',
  case when exists (
    select 1 from public.profiles
    where lower(email) = 'saimabdullah310@gmail.com'
      and role = 'owner' and device_limit = 10
  ) then 'PASS' else 'FAIL' end;

-- ============================================================
-- If any check shows FAIL, fix it before going live.
-- Re-run owner-bootstrap.sql if triggers or owner profile are missing.
-- Re-run schema.sql if tables or RLS are missing.
-- ============================================================
-- ============================================================
-- Owner operations — daily admin queries
-- ============================================================
-- Run these in Supabase Dashboard → SQL Editor as needed.
-- These are read-only / maintenance queries for the owner account.

-- 1) List all profiles (customers + owner)
select id, email, role, status, device_limit, created_at, updated_at
from public.profiles
order by created_at desc;

-- 2) List pending access requests (not yet approved)
select id, email, app_version, requested_at
from public.access_requests
where approved_at is null
order by requested_at desc;

-- 3) List all licensed devices per customer
select p.email, ld.device_hash, ld.last_seen_at
from public.licensed_devices ld
join public.profiles p on p.id = ld.user_id
order by ld.last_seen_at desc;

-- 4) Revoke a customer (blocks their license immediately)
update public.profiles
set status = 'revoked', updated_at = now()
where email = 'customer@example.com';

-- 5) Re-activate a revoked customer
update public.profiles
set status = 'active', updated_at = now()
where email = 'customer@example.com';

-- 6) Change a customer's device limit (1–10)
update public.profiles
set device_limit = 5, updated_at = now()
where email = 'customer@example.com';

-- 7) Delete a customer entirely (profile + devices)
-- NOTE: Also delete the auth user from Dashboard → Authentication → Users.
delete from public.licensed_devices
where user_id in (select id from public.profiles where email = 'customer@example.com');

delete from public.profiles
where email = 'customer@example.com';

-- 8) Count active customers
select count(*) as active_customers
from public.profiles
where role = 'customer' and status = 'active';

-- 9) Device usage summary (how many devices each customer has registered)
select p.email, count(ld.id) as device_count, p.device_limit
from public.profiles p
left join public.licensed_devices ld on ld.user_id = p.id
where p.role = 'customer'
group by p.email, p.device_limit
order by device_count desc;

-- 10) Recently active devices (last 7 days)
select p.email, ld.device_hash, ld.last_seen_at
from public.licensed_devices ld
join public.profiles p on p.id = ld.user_id
where ld.last_seen_at > now() - interval '7 days'
order by ld.last_seen_at desc;

-- 11) Access request approval history
select ar.email, ar.app_version, ar.requested_at, ar.approved_at, p.email as approved_by
from public.access_requests ar
left join public.profiles p on p.id = ar.approved_by
where ar.approved_at is not null
order by ar.approved_at desc;

-- 12) Owner email change (if you ever switch owner accounts)
-- insert into public.profiles (id, email, role)
-- select id, email, 'owner' from auth.users where email = 'new-owner@example.com'
-- on conflict (id) do update set role = 'owner';
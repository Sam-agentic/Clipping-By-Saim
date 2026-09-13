-- ============================================================
-- Owner bootstrap + auto-profile trigger
-- ============================================================
-- Run this AFTER creating an Auth user for saimabdullah310@gmail.com in
-- Supabase Dashboard → Authentication → Users. It grants the only owner role.
--
-- It also installs a trigger that automatically creates a profiles row for
-- any future Auth user (e.g. a customer invited via admin-approve), so the
-- profiles table always stays in sync with auth.users.

-- 1) Auto-create a profile whenever a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- New accounts start as 'pending' so a self-registered user stays locked
  -- until the owner approves them (admin-approve flips status to 'active').
  insert into public.profiles (id, email, role, status, device_limit)
  values (new.id, new.email, 'customer', 'pending', 2)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) Keep updated_at fresh whenever a profile row changes.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- 3) Grant the owner role to the specified email.
insert into public.profiles (id, email, role, status, device_limit)
select id, email, 'owner', 'active', 10
from auth.users
where lower(email) = 'saimabdullah310@gmail.com'
on conflict (id) do update
set role = 'owner', status = 'active', device_limit = 10;

-- 4) Optional: if you ever change the owner email, run this instead:
-- insert into public.profiles (id, email, role)
-- select id, email, 'owner' from auth.users where email = 'owner@example.com'
-- on conflict (id) do update set role = 'owner';
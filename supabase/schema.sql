-- Run once in the Supabase SQL editor. Replace OWNER_EMAIL before executing.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null default 'customer' check (role in ('owner', 'customer')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  device_limit integer not null default 2 check (device_limit between 1 and 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.access_requests (
  id bigint generated always as identity primary key,
  email text not null unique,
  app_version text,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users(id)
);
create table if not exists public.licensed_devices (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  device_hash text not null,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(user_id, device_hash)
);
alter table public.profiles enable row level security;
alter table public.access_requests enable row level security;
alter table public.licensed_devices enable row level security;
-- All browser/app access is through Edge Functions using the service role.
-- No direct client table policies are intentionally granted.

-- Keep updated_at fresh whenever a profile row changes.
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
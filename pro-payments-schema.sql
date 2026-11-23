create table if not exists public.pro_payments (
  payment_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(10, 2) not null check (amount = 199),
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists public.pro_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payment_id uuid not null unique references public.pro_payments(payment_id),
  provider text not null default 'yookassa',
  granted_at timestamptz not null default now()
);

alter table public.pro_payments enable row level security;
alter table public.pro_entitlements enable row level security;

grant select on public.pro_payments to authenticated;
grant select on public.pro_entitlements to authenticated;

drop policy if exists "Users can read their own Pro payments" on public.pro_payments;
create policy "Users can read their own Pro payments"
  on public.pro_payments for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their own Pro entitlement" on public.pro_entitlements;
create policy "Users can read their own Pro entitlement"
  on public.pro_entitlements for select to authenticated
  using ((select auth.uid()) = user_id);

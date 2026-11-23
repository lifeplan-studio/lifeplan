-- Run this once in the Supabase SQL Editor for the LifePlan project.
create table if not exists public.operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  amount numeric(14, 2) not null check (amount > 0),
  type text not null check (type in ('income', 'expense')),
  category text not null,
  date text not null
);

create index if not exists operations_user_id_id_idx
  on public.operations (user_id);

alter table public.operations
  add column if not exists date text not null default to_char(current_date, 'DD.MM.YYYY');

create table if not exists public.goals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  amount numeric(14, 2) not null default 0 check (amount >= 0)
);

alter table public.operations enable row level security;
alter table public.goals enable row level security;

grant select, insert, update, delete on public.operations to authenticated;
grant select, insert, update, delete on public.goals to authenticated;

drop policy if exists "Users can manage their own operations" on public.operations;
create policy "Users can manage their own operations"
  on public.operations for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can manage their own goals" on public.goals;
create policy "Users can manage their own goals"
  on public.goals for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

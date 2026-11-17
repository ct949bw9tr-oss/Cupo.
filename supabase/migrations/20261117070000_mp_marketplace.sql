-- Split de pagos de Mercado Pago (17 nov 2026).
-- Cada organizador conecta su cuenta de Mercado Pago (OAuth). Las ventas de sus eventos se cobran
-- con el token de SU cuenta: la plata le cae directo, Mercado Pago descuenta su comisión de ahí y
-- Cupo recibe el cargo por servicio como marketplace_fee.
-- Los eventos de un admin de Cupo sin cuenta conectada siguen cobrando con la cuenta de Cupo (MP_ACCESS_TOKEN).

-- Tokens de Mercado Pago de cada organizador: solo las Edge Functions (service_role) los leen.
create table public.mp_accounts (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  mp_user_id text not null,
  access_token text not null,
  refresh_token text,
  public_key text,
  expires_at timestamptz,
  connected_at timestamptz not null default now()
);
alter table public.mp_accounts enable row level security;
revoke all on public.mp_accounts from anon, authenticated;

-- "state" de un intento de conexión (protege el regreso desde Mercado Pago)
create table public.mp_oauth_states (
  state text primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.mp_oauth_states enable row level security;
revoke all on public.mp_oauth_states from anon, authenticated;

-- Con qué cuenta se cobró la orden: el organizador (su id) o la cuenta de Cupo (null)
alter table public.orders add column if not exists mp_seller_id uuid references public.profiles(id) on delete set null;

-- Estado de la conexión de la persona que tiene la sesión abierta (sin exponer tokens)
create or replace function public.my_mp_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'connected', exists (select 1 from public.mp_accounts where owner_id = auth.uid()),
    'connected_at', (select connected_at from public.mp_accounts where owner_id = auth.uid()),
    'is_admin', coalesce((select is_admin from public.profiles where id = auth.uid()), false));
$$;
revoke execute on function public.my_mp_status() from public, anon;
grant execute on function public.my_mp_status() to authenticated;

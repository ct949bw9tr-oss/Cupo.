-- Saldo del organizador en Cupo y retiros por transferencia bancaria (17 nov 2026).
-- Flujo: el cliente paga -> Mercado Pago cobra en la cuenta de Cupo -> el organizador ve su saldo
-- (lo vendido - comisión real de Mercado Pago - cargo de Cupo) -> cuando su evento termina pide el
-- retiro -> un admin de Cupo le transfiere a su cuenta y lo marca como pagado.
-- Las órdenes cobradas con la cuenta propia del organizador (split, mp_seller_id no nulo) no suman al saldo.

create table public.payout_accounts (
  owner_id uuid primary key references public.profiles(id) on delete cascade,
  holder_name text not null,
  doc_type text not null check (doc_type in ('CC', 'CE', 'NIT', 'PP')),
  doc_number text not null,
  bank text not null,
  account_type text not null check (account_type in ('ahorros', 'corriente', 'billetera')),
  account_number text not null,
  updated_at timestamptz not null default now()
);
alter table public.payout_accounts enable row level security;
revoke all on public.payout_accounts from anon, authenticated;

create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete restrict,
  amount integer not null check (amount > 0),
  status text not null default 'requested' check (status in ('requested', 'paid', 'rejected')),
  account jsonb not null,             -- copia de la cuenta al momento de pedir el retiro
  note text,                           -- nota del admin (p. ej. número de la transferencia)
  requested_at timestamptz not null default now(),
  paid_at timestamptz
);
alter table public.payouts enable row level security;
revoke all on public.payouts from anon, authenticated;

-- Neto de una orden para el organizador
create or replace function public.order_net(o public.orders)
returns integer language sql immutable set search_path = '' as $$
  select case when o.fee_mode = 'buyer' then o.subtotal - o.gateway_fee
              else o.subtotal - o.platform_fee - o.gateway_fee end;
$$;

-- Saldo de la persona con sesión abierta. Un evento se puede retirar 1 día después de empezar.
create or replace function public.host_balance()
returns jsonb language sql stable security definer set search_path = '' as $$
  with o as (
    select e.id as event_id, e.name, e.starts_at, (e.starts_at < now() - interval '1 day') as ended,
           public.order_net(o) as net
    from public.orders o join public.events e on e.id = o.event_id
    where e.owner_id = auth.uid() and o.status = 'paid' and o.mp_seller_id is null
  ), p as (
    select coalesce(sum(amount) filter (where status in ('requested', 'paid')), 0) as withdrawn,
           coalesce(sum(amount) filter (where status = 'requested'), 0) as requested,
           coalesce(sum(amount) filter (where status = 'paid'), 0) as paid
    from public.payouts where owner_id = auth.uid()
  )
  select jsonb_build_object(
    'earned', coalesce((select sum(net) from o), 0),
    'earned_ended', coalesce((select sum(net) from o where ended), 0),
    'withdrawn', (select withdrawn from p),
    'requested', (select requested from p),
    'paid', (select paid from p),
    'available', greatest(coalesce((select sum(net) from o where ended), 0) - (select withdrawn from p), 0),
    'account', (select to_jsonb(a) - 'owner_id' from public.payout_accounts a where a.owner_id = auth.uid()),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'status', status,
                  'requested_at', requested_at, 'paid_at', paid_at, 'note', note) order by requested_at desc)
                from public.payouts where owner_id = auth.uid()), '[]'::jsonb));
$$;

create or replace function public.save_payout_account(p_holder text, p_doc_type text, p_doc_number text,
  p_bank text, p_account_type text, p_account_number text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'NO_SESSION'; end if;
  if length(trim(coalesce(p_holder, ''))) < 3 then raise exception 'BAD_HOLDER'; end if;
  if p_doc_type not in ('CC', 'CE', 'NIT', 'PP') or regexp_replace(coalesce(p_doc_number, ''), '[^0-9A-Za-z]', '', 'g') !~ '^[0-9A-Za-z]{5,15}$' then
    raise exception 'BAD_DOC'; end if;
  if length(trim(coalesce(p_bank, ''))) < 3 then raise exception 'BAD_BANK'; end if;
  if p_account_type not in ('ahorros', 'corriente', 'billetera') then raise exception 'BAD_TYPE'; end if;
  if regexp_replace(coalesce(p_account_number, ''), '\D', '', 'g') !~ '^\d{6,20}$' then raise exception 'BAD_NUMBER'; end if;
  insert into public.payout_accounts (owner_id, holder_name, doc_type, doc_number, bank, account_type, account_number, updated_at)
  values (auth.uid(), trim(p_holder), p_doc_type, regexp_replace(p_doc_number, '[^0-9A-Za-z]', '', 'g'), trim(p_bank),
          p_account_type, regexp_replace(p_account_number, '\D', '', 'g'), now())
  on conflict (owner_id) do update set holder_name = excluded.holder_name, doc_type = excluded.doc_type,
    doc_number = excluded.doc_number, bank = excluded.bank, account_type = excluded.account_type,
    account_number = excluded.account_number, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- Pide el retiro de todo el saldo disponible (mínimo $10.000, uno pendiente a la vez)
create or replace function public.request_payout()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare acc public.payout_accounts; avail integer; pid uuid;
begin
  if auth.uid() is null then raise exception 'NO_SESSION'; end if;
  perform 1 from public.profiles where id = auth.uid() for update;   -- evita dos retiros al mismo tiempo
  select * into acc from public.payout_accounts where owner_id = auth.uid();
  if not found then raise exception 'NO_ACCOUNT'; end if;
  if exists (select 1 from public.payouts where owner_id = auth.uid() and status = 'requested') then
    raise exception 'PENDING_EXISTS'; end if;
  avail := (public.host_balance()->>'available')::int;
  if avail < 10000 then raise exception 'MIN_AMOUNT'; end if;
  insert into public.payouts (owner_id, amount, account)
  values (auth.uid(), avail, to_jsonb(acc) - 'owner_id') returning id into pid;
  return jsonb_build_object('ok', true, 'id', pid, 'amount', avail);
end $$;

-- Admin: retiros (pendientes primero) con los datos para transferir
create or replace function public.admin_payouts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'No autorizado'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'status', p.status,
      'requested_at', p.requested_at, 'paid_at', p.paid_at, 'note', p.note, 'account', p.account,
      'host', coalesce(pr.name, ''), 'email', coalesce(u.email, ''))
      order by (p.status = 'requested') desc, p.requested_at desc)
    from public.payouts p join public.profiles pr on pr.id = p.owner_id join auth.users u on u.id = p.owner_id), '[]'::jsonb);
end $$;

create or replace function public.mark_payout(p_id uuid, p_status text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'No autorizado'; end if;
  if p_status not in ('paid', 'rejected') then raise exception 'BAD_STATUS'; end if;
  update public.payouts set status = p_status, note = nullif(trim(coalesce(p_note, '')), ''),
         paid_at = case when p_status = 'paid' then now() else null end
   where id = p_id and status = 'requested';
  if not found then raise exception 'NOT_PENDING'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- El organizador recibe lo que vendió en Cupo: el "Tú recibes" del panel ya descuenta Mercado Pago y Cupo.
revoke execute on function public.order_net(public.orders), public.host_balance(), public.save_payout_account(text, text, text, text, text, text),
  public.request_payout(), public.admin_payouts(), public.mark_payout(uuid, text, text) from public, anon;
grant execute on function public.host_balance(), public.save_payout_account(text, text, text, text, text, text),
  public.request_payout(), public.admin_payouts(), public.mark_payout(uuid, text, text) to authenticated;

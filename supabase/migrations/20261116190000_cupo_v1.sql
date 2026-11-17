-- =====================================================================
-- Cupo v1 — esquema completo
-- =====================================================================

-- La tabla "orders" de un intento anterior (vacía) se guarda en otro esquema.
create schema if not exists archive;
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='orders' and column_name='amount_in_cents') then
    alter table public.orders set schema archive;
  end if;
end $$;
revoke all on schema archive from anon, authenticated;

-- ---------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------
create or replace function public.rand_code(n int)
returns text language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (get_byte(b, i) % 32) + 1, 1), '')
  from extensions.gen_random_bytes(n) b, generate_series(0, n - 1) i;
$$;

create or replace function public.norm_phone(p text)
returns text language sql immutable set search_path = '' as $$
  select case when length(d) = 10 and left(d, 1) = '3' then '57' || d else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') d) x;
$$;

create or replace function public.my_phone()
returns text language sql stable security definer set search_path = '' as $$
  select public.norm_phone(phone) from auth.users where id = auth.uid();
$$;

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references public.profiles(id),
  slug text not null unique,
  name text not null check (length(trim(name)) >= 2),
  starts_at timestamptz not null,
  venue text not null default '',
  address text not null default '',
  hide_address boolean not null default false,
  city text not null default 'Barranquilla',
  description text not null default '',
  cover_url text,
  palette text not null default 'neon',
  is_private boolean not null default false,
  access_code text not null unique,
  published boolean not null default true,
  allow_transfers boolean not null default true,
  fee_mode text not null default 'buyer' check (fee_mode in ('buyer', 'organizer')),
  spotify_url text,
  created_at timestamptz not null default now()
);
create index on public.events (owner_id);
create index on public.events (starts_at) where published and not is_private;

create table public.ticket_types (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  name text not null,
  price integer not null check (price >= 1000),
  quantity integer not null check (quantity >= 0),
  sold integer not null default 0 check (sold >= 0),
  sort integer not null default 0,
  sales_end timestamptz,
  unlock_after uuid references public.ticket_types(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on public.ticket_types (event_id);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  reference text not null unique,
  event_id uuid not null references public.events(id) on delete restrict,
  buyer_id uuid references public.profiles(id) on delete set null,
  buyer_name text not null,
  buyer_email text not null default '',
  buyer_phone text not null default '',
  items jsonb not null,
  qty integer not null check (qty > 0),
  subtotal integer not null,
  platform_fee integer not null,
  gateway_fee integer not null,
  total integer not null,
  fee_mode text not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  wompi_tx_id text,
  wompi_status text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.orders (event_id, status);

create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  order_id uuid not null references public.orders(id) on delete restrict,
  event_id uuid not null references public.events(id) on delete restrict,
  ticket_type_id uuid not null references public.ticket_types(id) on delete restrict,
  type_name text not null,
  holder_name text not null,
  holder_phone text not null,
  transfers integer not null default 0,
  price integer not null,
  checked_in_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.tickets (event_id);
create index on public.tickets (holder_phone);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------
-- Perfil automático al registrarse
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
insert into public.profiles (id) select id from auth.users on conflict do nothing;

-- slug, código privado y dueño los pone el servidor
create or replace function public.events_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare base text;
begin
  if auth.uid() is not null then new.owner_id := auth.uid(); end if;
  base := lower(translate(trim(new.name), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'));
  base := trim(both '-' from regexp_replace(base, '[^a-z0-9]+', '-', 'g'));
  base := left(coalesce(nullif(base, ''), 'evento'), 40);
  new.slug := base || '-' || lower(public.rand_code(4));
  new.access_code := public.rand_code(6);
  return new;
end $$;
create trigger events_before_insert before insert on public.events
  for each row execute function public.events_before_insert();

-- Una etapa solo se puede encadenar a otra del mismo evento
create or replace function public.ticket_types_check()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.unlock_after is not null and not exists (
       select 1 from public.ticket_types where id = new.unlock_after and event_id = new.event_id and id <> new.id) then
    raise exception 'Etapa anterior no válida';
  end if;
  if tg_op = 'UPDATE' and new.event_id <> old.event_id then
    raise exception 'No se puede mover una boleta de evento';
  end if;
  return new;
end $$;
create trigger ticket_types_check before insert or update on public.ticket_types
  for each row execute function public.ticket_types_check();

-- ---------------------------------------------------------------------
-- Permisos y RLS
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.ticket_types enable row level security;
alter table public.orders enable row level security;
alter table public.tickets enable row level security;

revoke all on public.profiles, public.events, public.ticket_types, public.orders, public.tickets from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (name) on public.profiles to authenticated;

grant select, delete on public.events to authenticated;
grant insert (name, starts_at, venue, address, hide_address, city, description, cover_url, palette,
              is_private, published, allow_transfers, fee_mode, spotify_url) on public.events to authenticated;
grant update (name, starts_at, venue, address, hide_address, city, description, cover_url, palette,
              is_private, published, allow_transfers, fee_mode, spotify_url) on public.events to authenticated;

grant select, delete on public.ticket_types to authenticated;
grant insert (event_id, name, price, quantity, sort, sales_end, unlock_after) on public.ticket_types to authenticated;
grant update (name, price, quantity, sort, sales_end, unlock_after) on public.ticket_types to authenticated;

grant select on public.orders, public.tickets to authenticated;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.owns_event(p_event uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.events where id = p_event and owner_id = auth.uid());
$$;

create policy "perfil propio" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "editar perfil propio" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "ver mis eventos" on public.events for select to authenticated
  using (owner_id = (select auth.uid()) or (select public.is_admin()));
create policy "crear evento" on public.events for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "editar mi evento" on public.events for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "borrar mi evento" on public.events for delete to authenticated using (owner_id = (select auth.uid()));

create policy "ver boletas de mis eventos" on public.ticket_types for select to authenticated
  using ((select public.owns_event(event_id)) or (select public.is_admin()));
create policy "crear tipo de boleta" on public.ticket_types for insert to authenticated
  with check ((select public.owns_event(event_id)));
create policy "editar tipo de boleta" on public.ticket_types for update to authenticated
  using ((select public.owns_event(event_id))) with check ((select public.owns_event(event_id)) and quantity >= sold);
create policy "borrar tipo de boleta sin ventas" on public.ticket_types for delete to authenticated
  using ((select public.owns_event(event_id)) and sold = 0);

create policy "ver ordenes de mis eventos" on public.orders for select to authenticated
  using ((select public.owns_event(event_id)) or (select public.is_admin()));
create policy "ver tiquetes de mis eventos" on public.tickets for select to authenticated
  using ((select public.owns_event(event_id)) or (select public.is_admin()));

-- ---------------------------------------------------------------------
-- Lógica de negocio
-- ---------------------------------------------------------------------
-- Comisiones: Cupo 2 %; Wompi 2,65 % + $700, más IVA 19 % sobre la comisión de Wompi
create or replace function public.calc_fees(p_subtotal integer, p_mode text)
returns table (platform_fee integer, gateway_fee integer, total integer)
language plpgsql immutable set search_path = '' as $$
declare pf numeric; t numeric;
begin
  pf := round(p_subtotal * 0.02);
  if p_mode = 'buyer' then
    t := ceil((p_subtotal + pf + 700 * 1.19) / (1 - 0.0265 * 1.19));
  else
    t := p_subtotal;
  end if;
  platform_fee := pf::int;
  total := t::int;
  gateway_fee := ceil((t * 0.0265 + 700) * 1.19)::int;
  return next;
end $$;

-- Boletas apartadas por órdenes pendientes recientes (30 min) para no sobrevender
create or replace function public.reserved_qty(p_type uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce(sum((it->>'qty')::int), 0)::int
  from public.orders o, jsonb_array_elements(o.items) it
  where o.status = 'pending' and o.created_at > now() - interval '30 minutes'
    and (it->>'ticket_type_id')::uuid = p_type;
$$;

create or replace function public.tt_state(t public.ticket_types)
returns text language plpgsql stable security definer set search_path = '' as $$
declare p public.ticket_types;
begin
  if t.sales_end is not null and now() > t.sales_end then return 'ended'; end if;
  if t.unlock_after is not null then
    select * into p from public.ticket_types where id = t.unlock_after;
    if found and p.sold < p.quantity and not (p.sales_end is not null and now() > p.sales_end) then
      return 'locked';
    end if;
  end if;
  return 'open';
end $$;

create or replace function public.event_json(e public.events, p_reveal boolean default false)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id, 'slug', e.slug, 'name', e.name, 'starts_at', e.starts_at, 'venue', e.venue, 'city', e.city,
    'description', e.description, 'cover_url', e.cover_url, 'palette', e.palette, 'is_private', e.is_private,
    'fee_mode', e.fee_mode, 'hide_address', e.hide_address,
    'address', case when e.hide_address and not p_reveal then null else e.address end,
    'spotify_url', e.spotify_url, 'allow_transfers', e.allow_transfers,
    'host', coalesce((select nullif(trim(name), '') from public.profiles where id = e.owner_id), 'Cupo Eventos'),
    'ticket_types', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'price', t.price,
        'available', greatest(0, t.quantity - t.sold - public.reserved_qty(t.id)),
        'state', public.tt_state(t), 'sales_end', t.sales_end,
        'unlock_after_name', (select name from public.ticket_types where id = t.unlock_after)
      ) order by t.sort, t.price)
      from public.ticket_types t where t.event_id = e.id), '[]'::jsonb));
$$;

create or replace function public.list_public_events()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.event_json(e) order by e.starts_at), '[]'::jsonb)
  from public.events e
  where e.published and not e.is_private and e.starts_at > now() - interval '12 hours';
$$;

create or replace function public.get_event(p_slug text, p_code text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e public.events; mine boolean;
begin
  select * into e from public.events where slug = p_slug;
  if not found then return null; end if;
  mine := e.owner_id = auth.uid();
  if not e.published and not mine then return null; end if;
  if e.is_private and not mine and upper(coalesce(p_code, '')) <> e.access_code then
    return jsonb_build_object('locked', true, 'slug', e.slug, 'name', e.name);
  end if;
  return public.event_json(e, mine);
end $$;

create or replace function public.find_private_event(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('slug', slug, 'code', access_code)
  from public.events
  where is_private and published and access_code = upper(trim(coalesce(p_code, '')));
$$;

create or replace function public.get_order(p_order uuid, p_token uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'reference', o.reference, 'status', o.status, 'total', o.total,
    'buyer_name', o.buyer_name, 'qty', o.qty,
    'event', jsonb_build_object('name', e.name, 'slug', e.slug, 'starts_at', e.starts_at, 'venue', e.venue,
      'address', case when o.status = 'paid' then e.address else '' end, 'spotify_url', e.spotify_url,
      'city', e.city, 'palette', e.palette, 'cover_url', e.cover_url),
    'tickets', coalesce((select jsonb_agg(jsonb_build_object('code', t.code, 'type_name', t.type_name,
        'holder_name', t.holder_name, 'checked_in_at', t.checked_in_at))
      from public.tickets t where t.order_id = o.id and t.holder_phone = o.buyer_phone), '[]'::jsonb))
  from public.orders o join public.events e on e.id = o.event_id
  where o.id = p_order and o.token = p_token;
$$;

create or replace function public.my_tickets()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', t.code, 'type_name', t.type_name, 'holder_name', t.holder_name,
    'checked_in_at', t.checked_in_at, 'transfers', t.transfers,
    'event', jsonb_build_object('id', e.id, 'slug', e.slug, 'name', e.name, 'starts_at', e.starts_at,
      'venue', e.venue, 'address', e.address, 'city', e.city, 'palette', e.palette, 'cover_url', e.cover_url,
      'spotify_url', e.spotify_url, 'allow_transfers', e.allow_transfers)
  ) order by e.starts_at), '[]'::jsonb)
  from public.tickets t join public.events e on e.id = t.event_id
  where public.my_phone() is not null and t.holder_phone = public.my_phone();
$$;

create or replace function public.transfer_ticket(p_code text, p_phone text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.tickets; e public.events; dest text := public.norm_phone(p_phone); me text := public.my_phone();
begin
  if length(dest) < 10 then raise exception 'BAD_PHONE'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'BAD_NAME'; end if;
  select * into t from public.tickets where code = p_code for update;
  if not found or me is null or t.holder_phone <> me then raise exception 'NOT_YOURS'; end if;
  if dest = me then raise exception 'SAME_PHONE'; end if;
  if t.checked_in_at is not null then raise exception 'ALREADY_USED'; end if;
  select * into e from public.events where id = t.event_id;
  if not e.allow_transfers then raise exception 'NO_TRANSFERS'; end if;
  if e.starts_at < now() - interval '12 hours' then raise exception 'EVENT_OVER'; end if;
  update public.tickets
     set holder_phone = dest, holder_name = trim(p_name),
         code = 'CUP-' || public.rand_code(4) || '-' || public.rand_code(4),
         transfers = transfers + 1
   where id = t.id;
  return jsonb_build_object('ok', true, 'to_phone', dest, 'event', e.name);
end $$;

create or replace function public.event_summary(p_event uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not (public.owns_event(p_event) or public.is_admin()) then raise exception 'No autorizado'; end if;
  return (
    select jsonb_build_object(
      'tickets', (select coalesce(sum(sold), 0) from public.ticket_types where event_id = p_event),
      'orders', count(*),
      'gross', coalesce(sum(total), 0),
      'subtotal', coalesce(sum(subtotal), 0),
      'platform_fee', coalesce(sum(platform_fee), 0),
      'gateway_fee', coalesce(sum(gateway_fee), 0),
      'organizer_net', coalesce(sum(case when fee_mode = 'buyer' then subtotal
                                         else subtotal - platform_fee - gateway_fee end), 0),
      'checked_in', (select count(*) from public.tickets where event_id = p_event and checked_in_at is not null))
    from public.orders where event_id = p_event and status = 'paid');
end $$;

create or replace function public.check_in(p_event uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.tickets;
begin
  if not public.owns_event(p_event) then raise exception 'No autorizado'; end if;
  select * into t from public.tickets where code = upper(trim(p_code)) for update;
  if not found or t.event_id <> p_event then return jsonb_build_object('result', 'invalid'); end if;
  if t.checked_in_at is not null then
    return jsonb_build_object('result', 'used', 'holder', t.holder_name, 'type', t.type_name, 'at', t.checked_in_at);
  end if;
  update public.tickets set checked_in_at = now() where id = t.id;
  return jsonb_build_object('result', 'ok', 'holder', t.holder_name, 'type', t.type_name);
end $$;

create or replace function public.platform_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'No autorizado'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'event', e.name, 'starts_at', e.starts_at, 'owner', coalesce(p.name, ''),
      'tickets', s->'tickets', 'gross', s->'gross', 'platform_fee', s->'platform_fee',
      'owed_to_organizer', s->'organizer_net') order by e.starts_at desc)
    from public.events e
    left join public.profiles p on p.id = e.owner_id
    cross join lateral public.event_summary(e.id) s
    where exists (select 1 from public.orders o where o.event_id = e.id and o.status = 'paid')), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- Pagos (solo las Edge Functions con service_role los llaman)
-- ---------------------------------------------------------------------
create or replace function public.create_order_internal(p_user uuid, p_slug text, p_code text, p_items jsonb, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e public.events; t public.ticket_types; it jsonb; q int; n int := 0; sub int := 0;
  items jsonb := '[]'::jsonb; f record; ph text; ref text; o public.orders;
begin
  select public.norm_phone(phone) into ph from auth.users where id = p_user;
  if ph is null or ph = '' then return jsonb_build_object('error', 'Entra con tu celular para comprar.'); end if;
  select * into e from public.events where slug = p_slug;
  if not found or not e.published then return jsonb_build_object('error', 'Este evento no existe.'); end if;
  if e.is_private and upper(coalesce(p_code, '')) <> e.access_code and e.owner_id <> p_user then
    return jsonb_build_object('error', 'Código no válido.');
  end if;
  if length(trim(coalesce(p_name, ''))) < 3 then return jsonb_build_object('error', 'Escribe tu nombre completo.'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('error', 'Elige al menos una boleta.');
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::int;
    if q is null or q <= 0 then continue; end if;
    if q > 20 then return jsonb_build_object('error', 'Máximo 20 boletas por tipo en una compra.'); end if;
    select * into t from public.ticket_types where id = (it->>'ticket_type_id')::uuid and event_id = e.id for update;
    if not found then return jsonb_build_object('error', 'Boleta no válida.'); end if;
    if public.tt_state(t) <> 'open' then
      return jsonb_build_object('error', format('Las boletas "%s" no están a la venta en este momento.', t.name));
    end if;
    if t.sold + public.reserved_qty(t.id) + q > t.quantity then
      return jsonb_build_object('error', format('No quedan suficientes boletas "%s".', t.name));
    end if;
    items := items || jsonb_build_object('ticket_type_id', t.id, 'name', t.name, 'qty', q, 'price', t.price);
    n := n + q; sub := sub + q * t.price;
  end loop;
  if n = 0 then return jsonb_build_object('error', 'Elige al menos una boleta.'); end if;

  select * into f from public.calc_fees(sub, e.fee_mode);
  ref := 'CUP-' || to_char(now() at time zone 'America/Bogota', 'YYMMDD') || '-' || public.rand_code(8);
  insert into public.orders (reference, event_id, buyer_id, buyer_name, buyer_phone, items, qty, subtotal,
                             platform_fee, gateway_fee, total, fee_mode)
  values (ref, e.id, p_user, trim(p_name), ph, items, n, sub, f.platform_fee, f.gateway_fee, f.total, e.fee_mode)
  returning * into o;
  return jsonb_build_object('orderId', o.id, 'token', o.token, 'reference', o.reference,
                            'amountInCents', o.total::bigint * 100, 'currency', 'COP');
end $$;

-- Idempotente: si llegan dos avisos de Wompi, las boletas se emiten una sola vez
create or replace function public.finalize_order(p_reference text, p_tx_id text, p_status text, p_amount_in_cents bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders; it jsonb; i int; tt public.ticket_types;
begin
  select * into o from public.orders where reference = p_reference for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if o.status = 'paid' then return jsonb_build_object('result', 'already_paid'); end if;

  if p_status = 'APPROVED' then
    if p_amount_in_cents <> o.total::bigint * 100 then
      update public.orders set wompi_tx_id = p_tx_id, wompi_status = 'AMOUNT_MISMATCH' where id = o.id;
      return jsonb_build_object('result', 'amount_mismatch');
    end if;
    for it in select * from jsonb_array_elements(o.items) loop
      select * into tt from public.ticket_types where id = (it->>'ticket_type_id')::uuid for update;
      update public.ticket_types set sold = sold + (it->>'qty')::int where id = tt.id;
      for i in 1 .. (it->>'qty')::int loop
        insert into public.tickets (code, order_id, event_id, ticket_type_id, type_name, holder_name, holder_phone, price)
        values ('CUP-' || public.rand_code(4) || '-' || public.rand_code(4), o.id, o.event_id, tt.id, tt.name,
                o.buyer_name, o.buyer_phone, (it->>'price')::int);
      end loop;
    end loop;
    update public.orders set status = 'paid', paid_at = now(), wompi_tx_id = p_tx_id, wompi_status = p_status where id = o.id;
    return jsonb_build_object('result', 'paid');
  elsif p_status in ('DECLINED', 'VOIDED', 'ERROR') then
    update public.orders set status = 'failed', wompi_tx_id = p_tx_id, wompi_status = p_status where id = o.id;
    return jsonb_build_object('result', 'failed');
  else
    update public.orders set wompi_tx_id = p_tx_id, wompi_status = p_status where id = o.id;
    return jsonb_build_object('result', 'pending');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Quién puede llamar qué
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.list_public_events(), public.get_event(text, text), public.find_private_event(text),
  public.calc_fees(integer, text), public.get_order(uuid, uuid) to anon, authenticated;
grant execute on function public.my_tickets(), public.transfer_ticket(text, text, text), public.event_summary(uuid),
  public.check_in(uuid, text), public.platform_summary() to authenticated;
-- helpers que usan las políticas RLS
grant execute on function public.is_admin(), public.owns_event(uuid) to authenticated;
grant execute on function public.create_order_internal(uuid, text, text, jsonb, text),
  public.finalize_order(text, text, text, bigint) to service_role;

alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Storage: flyers / portadas
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('covers', 'covers', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "subir mi portada" on storage.objects for insert to authenticated
  with check (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "borrar mi portada" on storage.objects for delete to authenticated
  using (bucket_id = 'covers' and (storage.foldername(name))[1] = (select auth.uid())::text);

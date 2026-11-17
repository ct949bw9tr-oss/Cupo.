-- Login por correo en vez de celular (17 nov 2026).
-- La identidad de cada persona pasa a ser su correo (verificado con un código que llega al correo):
-- las boletas se guardan en holder_email, se transfieren por correo y "Mis boletas" busca por el correo.
-- holder_phone / buyer_phone quedan en las tablas pero ya no se usan.

alter table public.tickets add column if not exists holder_email text not null default '';
alter table public.tickets alter column holder_phone set default '';
create index if not exists tickets_holder_email_idx on public.tickets (holder_email);

create or replace function public.norm_email(p text)
returns text language sql immutable set search_path = '' as $$
  select lower(trim(coalesce(p, '')));
$$;

create or replace function public.my_email()
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(public.norm_email(email), '') from auth.users where id = auth.uid();
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
      from public.tickets t where t.order_id = o.id and t.holder_email = o.buyer_email), '[]'::jsonb))
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
  where public.my_email() <> '' and t.holder_email = public.my_email();
$$;

-- El parámetro cambia de nombre (p_phone -> p_email), por eso se borra y se crea de nuevo
drop function if exists public.transfer_ticket(text, text, text);
create function public.transfer_ticket(p_code text, p_email text, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.tickets; e public.events; dest text := public.norm_email(p_email); me text := public.my_email();
begin
  if dest !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'BAD_EMAIL'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'BAD_NAME'; end if;
  select * into t from public.tickets where code = p_code for update;
  if not found or coalesce(me, '') = '' or t.holder_email <> me then raise exception 'NOT_YOURS'; end if;
  if dest = me then raise exception 'SAME_EMAIL'; end if;
  if t.checked_in_at is not null then raise exception 'ALREADY_USED'; end if;
  select * into e from public.events where id = t.event_id;
  if not e.allow_transfers then raise exception 'NO_TRANSFERS'; end if;
  if e.starts_at < now() - interval '12 hours' then raise exception 'EVENT_OVER'; end if;
  update public.tickets
     set holder_email = dest, holder_phone = '', holder_name = trim(p_name),
         code = 'CUP-' || public.rand_code(4) || '-' || public.rand_code(4),
         transfers = transfers + 1
   where id = t.id;
  return jsonb_build_object('ok', true, 'to_email', dest, 'event', e.name);
end $$;

create or replace function public.create_order_internal(p_user uuid, p_slug text, p_code text, p_items jsonb, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e public.events; t public.ticket_types; it jsonb; q int; n int := 0; sub int := 0;
  items jsonb := '[]'::jsonb; f record; em text; ref text; o public.orders;
begin
  select public.norm_email(email) into em from auth.users where id = p_user;
  if em is null or em = '' then return jsonb_build_object('error', 'Entra con tu correo para comprar.'); end if;
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
  insert into public.orders (reference, event_id, buyer_id, buyer_name, buyer_email, items, qty, subtotal,
                             platform_fee, gateway_fee, total, fee_mode)
  values (ref, e.id, p_user, trim(p_name), em, items, n, sub, f.platform_fee, f.gateway_fee, f.total, e.fee_mode)
  returning * into o;
  return jsonb_build_object('orderId', o.id, 'token', o.token, 'reference', o.reference,
                            'amountInCents', o.total::bigint * 100, 'currency', 'COP');
end $$;

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
        insert into public.tickets (code, order_id, event_id, ticket_type_id, type_name, holder_name, holder_email, price)
        values ('CUP-' || public.rand_code(4) || '-' || public.rand_code(4), o.id, o.event_id, tt.id, tt.name,
                o.buyer_name, o.buyer_email, (it->>'price')::int);
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

revoke execute on function public.norm_email(text), public.my_email(), public.transfer_ticket(text, text, text) from public, anon;
grant execute on function public.transfer_ticket(text, text, text) to authenticated;

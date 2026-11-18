-- Compra como invitado (18 nov 2026): se puede comprar sin crear cuenta, solo con nombre y correo.
-- Las boletas quedan a nombre de ese correo (holder_email), así que si la persona entra después a Cupo
-- con ese correo, las ve en "Boletas". La orden (con su token secreto) muestra el QR apenas se paga.
-- Contra abusos (apartar boletas sin pagar): máximo 3 órdenes pendientes por correo cada 30 minutos
-- y máximo 10 boletas por tipo en una compra de invitado.

drop function if exists public.create_order_internal(uuid, text, text, jsonb, text);

create or replace function public.create_order_internal(p_user uuid, p_slug text, p_code text, p_items jsonb,
  p_name text, p_email text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  e public.events; t public.ticket_types; it jsonb; q int; n int := 0; sub int := 0;
  items jsonb := '[]'::jsonb; f record; em text; ref text; o public.orders; guest boolean := p_user is null;
begin
  if guest then
    em := public.norm_email(p_email);
    if em is null or em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(em) > 200 then
      return jsonb_build_object('error', 'Revisa tu correo.');
    end if;
    if (select count(*) from public.orders where buyer_email = em and status = 'pending'
          and created_at > now() - interval '30 minutes') >= 3 then
      return jsonb_build_object('error', 'Tienes varias compras sin terminar. Espera unos minutos e intenta otra vez.');
    end if;
  else
    select public.norm_email(email) into em from auth.users where id = p_user;
    if em is null or em = '' then return jsonb_build_object('error', 'Entra con tu correo para comprar.'); end if;
  end if;

  select * into e from public.events where slug = p_slug;
  if not found or not e.published then return jsonb_build_object('error', 'Este evento no existe.'); end if;
  if e.is_private and upper(coalesce(p_code, '')) <> e.access_code and e.owner_id is distinct from p_user then
    return jsonb_build_object('error', 'Código no válido.');
  end if;
  if length(trim(coalesce(p_name, ''))) < 3 then return jsonb_build_object('error', 'Escribe tu nombre completo.'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('error', 'Elige al menos una boleta.');
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::int;
    if q is null or q <= 0 then continue; end if;
    if q > (case when guest then 10 else 20 end) then
      return jsonb_build_object('error', format('Máximo %s boletas por tipo en una compra.', case when guest then 10 else 20 end));
    end if;
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

revoke execute on function public.create_order_internal(uuid, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.create_order_internal(uuid, text, text, jsonb, text, text) to service_role;

-- La orden ahora también devuelve el correo del comprador (solo quien tiene el token secreto la ve),
-- para decirle al invitado con qué correo puede volver a ver sus boletas.
create or replace function public.get_order(p_order uuid, p_token uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'reference', o.reference, 'status', o.status, 'total', o.total,
    'buyer_name', o.buyer_name, 'buyer_email', o.buyer_email, 'qty', o.qty,
    'event', jsonb_build_object('name', e.name, 'slug', e.slug, 'starts_at', e.starts_at, 'venue', e.venue,
      'address', case when o.status = 'paid' then e.address else '' end, 'spotify_url', e.spotify_url,
      'city', e.city, 'palette', e.palette, 'cover_url', e.cover_url),
    'tickets', coalesce((select jsonb_agg(jsonb_build_object('code', t.code, 'type_name', t.type_name,
        'holder_name', t.holder_name, 'checked_in_at', t.checked_in_at))
      from public.tickets t where t.order_id = o.id and t.holder_email = o.buyer_email), '[]'::jsonb))
  from public.orders o join public.events e on e.id = o.event_id
  where o.id = p_order and o.token = p_token;
$$;

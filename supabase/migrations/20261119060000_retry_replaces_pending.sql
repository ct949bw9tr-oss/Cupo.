-- Reintentos de compra (19 nov 2026): cuando alguien vuelve a tocar "Pagar" para el mismo evento,
-- sus órdenes pendientes anteriores de ese evento se cancelan (liberan las boletas apartadas) en vez de
-- bloquearlo por "varias compras sin terminar". Si un pago viejo igual se aprueba después,
-- finalize_order lo acepta (solo 'paid' es definitivo), así que no se pierde ninguna venta.
-- Límite anti-abuso que queda: 5 órdenes pendientes por correo en 30 minutos (sumando todos los eventos).
create or replace function public.create_order_internal(p_user uuid, p_slug text, p_code text, p_items jsonb,
  p_name text, p_email text)
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
  else
    select public.norm_email(email) into em from auth.users where id = p_user;
    if em is null or em = '' then return jsonb_build_object('error', 'Entra con tu correo para comprar.'); end if;
  end if;

  select * into e from public.events where slug = p_slug;
  if not found or not e.published then return jsonb_build_object('error', 'Este evento no existe.'); end if;
  if e.is_private and upper(coalesce(p_code, '')) <> e.access_code and e.owner_id is distinct from p_user then
    return jsonb_build_object('error', 'Código no válido.');
  end if;

  -- Reintento: cancela sus órdenes pendientes anteriores de este evento (libera las boletas apartadas)
  update public.orders set status = 'failed', wompi_status = 'REPLACED'
   where buyer_email = em and event_id = e.id and status = 'pending';
  if (select count(*) from public.orders where buyer_email = em and status = 'pending'
        and created_at > now() - interval '30 minutes') >= 5 then
    return jsonb_build_object('error', 'Tienes varias compras sin terminar. Espera unos minutos e intenta otra vez.');
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

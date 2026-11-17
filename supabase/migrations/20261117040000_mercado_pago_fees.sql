-- Comisiones con Mercado Pago (17 nov 2026)
--
-- fee_mode = 'buyer' (por defecto):
--   el comprador paga  precio + cargo por servicio de Cupo (2 %).
--   La comisión de Mercado Pago se descuenta del precio de la boleta (lo recibe el organizador),
--   así el cargo por servicio le llega completo a Cupo.
-- fee_mode = 'organizer':
--   el comprador paga el precio exacto; el 2 % de Cupo y la comisión de Mercado Pago
--   se descuentan de lo que recibe el organizador.
--
-- gateway_fee es una ESTIMACIÓN de la comisión de Mercado Pago (3,29 % + $800, más IVA 19 %).
-- Confirmar la tarifa real en el panel de Mercado Pago (Tu negocio → Costos) y ajustar aquí.

create or replace function public.calc_fees(p_subtotal integer, p_mode text)
returns table (platform_fee integer, gateway_fee integer, total integer)
language plpgsql immutable set search_path = '' as $$
declare pf numeric; t numeric;
begin
  pf := round(p_subtotal * 0.02);
  if p_mode = 'buyer' then t := p_subtotal + pf; else t := p_subtotal; end if;
  platform_fee := pf::int;
  total := t::int;
  gateway_fee := ceil((t * 0.0329 + 800) * 1.19)::int;
  return next;
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
      'organizer_net', coalesce(sum(case when fee_mode = 'buyer' then subtotal - gateway_fee
                                         else subtotal - platform_fee - gateway_fee end), 0),
      'checked_in', (select count(*) from public.tickets where event_id = p_event and checked_in_at is not null))
    from public.orders where event_id = p_event and status = 'paid');
end $$;

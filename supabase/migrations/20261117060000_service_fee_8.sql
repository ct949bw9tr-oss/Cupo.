-- Cargo por servicio de Cupo = 8 % del subtotal, redondeado hacia arriba a los $100
-- (boleta de $50.000 -> $4.000; sube con el precio). Le llega completo a Cupo.
-- La comisión de Mercado Pago (estimada: 3,29 % + $800 + IVA 19 % sobre el total cobrado)
-- se descuenta de lo que recibe el organizador (ver event_summary).
create or replace function public.calc_fees(p_subtotal integer, p_mode text)
returns table (platform_fee integer, gateway_fee integer, total integer)
language plpgsql immutable set search_path = '' as $$
declare pf numeric; t numeric;
begin
  pf := ceil(p_subtotal * 0.08 / 100.0) * 100;
  if p_mode = 'buyer' then t := p_subtotal + pf; else t := p_subtotal; end if;
  platform_fee := pf::int;
  total := t::int;
  gateway_fee := ceil((t * 0.0329 + 800) * 1.19)::int;
  return next;
end $$;

# Cupo — contexto para Claude Code

Cupo es una app de boletería estilo Posh para Barranquilla, Colombia. La gente crea eventos
(públicos o privados), vende boletas y Cupo cobra un cargo por servicio del 8 % por boleta ($4.000 en una de $50.000).

**Meta inmediata:** vender las boletas de la fiesta del dueño en Barranquilla en **diciembre de 2026**.
La v1 solo necesita que esa venta funcione de punta a punta. La plataforma completa para otros
organizadores viene después. Prioriza que funcione y sea seguro sobre agregar funciones.

Habla en español con el dueño. Es estudiante y no es programador de tiempo completo:
explica los pasos manuales (consolas de Supabase/Wompi/Vercel) de forma simple y concreta.

## Stack
- **Frontend:** un solo archivo `web/index.html` (HTML + CSS + JS sin framework, mobile-first, rutas con hash `#/...`).
  Lee la configuración de `web/config.js` (copiar de `config.example.js`; está en .gitignore).
- **Backend:** Supabase (Postgres + Auth con código (OTP) al correo + Storage para flyers + Edge Functions).
  El login era por celular (SMS); se cambió a correo el 17 nov 2026 para no pagar SMS. La identidad es el correo.
- **Pagos:** Mercado Pago Checkout Pro (redirección a la página de pago de Mercado Pago). Moneda COP.
  Se cambió desde Wompi el 17 nov 2026 por problemas con la cuenta de Wompi.
- **Hosting sugerido:** Vercel (sitio estático desde `web/`).

## Estado actual (16 nov 2026)
- **Backend creado** en el proyecto Supabase `cupo` (ref `xlkyrtjtwyzpmjsdokgn`, us-east-1):
  migración `supabase/migrations/20261116190000_cupo_v1.sql` aplicada (tablas, RLS, RPCs, bucket `covers`)
  y Edge Functions `create-order`, `confirm-order`, `wompi-webhook` desplegadas. Flujo probado con SQL.
- La tabla `orders` vieja de un intento anterior quedó en el esquema `archive` (vacía).
- `web/config.js` ya apunta a ese proyecto.
- `demo/index.html` = vista de prueba original con todo simulado (OTP `123456`). Referencia de comportamiento.
- **17 nov 2026:** pagos migrados a Mercado Pago. Funciones `create-order`, `confirm-order` y `mp-webhook`
  desplegadas (comparten `supabase/functions/_shared/mp.ts`). `wompi-webhook` sigue desplegada pero ya no se usa.
  Comisiones en `20261117040000_mercado_pago_fees.sql` y cargo del 8 % en `20261117060000_service_fee_8.sql`.
- **Login por correo** (migración `20261117050000_email_login.sql`): boletas en `tickets.holder_email`, `my_tickets()` busca
  por `my_email()`, `transfer_ticket(p_code, p_email, p_name)`, la orden guarda `buyer_email`. Los correos se
  mandan con SMTP propio configurado en Supabase (plantillas Magic Link y Confirm signup con `{{ .Token }}`).
  Las columnas `holder_phone` / `buyer_phone` quedan sin uso. La cuenta vieja del dueño era por celular.
- Evento `Throwback 2016-2018` creado, oculto, fecha provisional.
- **Pendiente manual:** secreto `MP_ACCESS_TOKEN` en Supabase (primero el de prueba), probar una compra,
  confirmar la comisión real de Mercado Pago en su panel, proveedor de SMS real (Twilio) y publicar en producción.
- Stock: una orden pendiente aparta sus boletas 30 min (`reserved_qty`); el webhook es la fuente de verdad.

## Contrato que el frontend espera (sacado de la demo)

Nota: la demo ya usa correo (cualquier correo + código 123456).

Tablas que se leen/escriben directo: `profiles` (id, name, is_admin), `events`, `ticket_types`, `orders`, `tickets`.

Campos de `events`: id, owner_id, slug, name, starts_at, venue, address, city, description, cover_url,
palette, is_private, access_code, published, allow_transfers, fee_mode ('buyer' | 'organizer'), spotify_url, created_at.
`ticket_types`: id, event_id, name, price, quantity, sold, sales_end, unlock_after (id de otra etapa: se abre cuando esa se agota).
`orders`: id, token, reference (`CUP-AAMMDD-XXXXXXXX`), event_id, buyer_name, buyer_phone, items, qty, subtotal, fee_mode, total, status ('pending' | 'paid' | 'failed').
`tickets`: id, code (`CUP-XXXX-XXXX`), order_id, event_id, ticket_type_id, type_name, holder_name, holder_email, transfers, price, checked_in_at.

RPCs (`sb.rpc`) — ver implementación de referencia en `demo/index.html`, objeto `RPC`:
`list_public_events`, `get_event(p_slug,p_code)`, `find_private_event(p_code)`, `calc_fees(p_subtotal,p_mode)`,
`get_order(p_order,p_token)`, `event_summary(p_event)`, `check_in(p_event,p_code)`, `my_tickets()`,
`transfer_ticket(p_code,p_email,p_name)` (rota el código de la boleta), `platform_summary()` (solo admin).

Flujo de plata (migración `20261117080000_host_balance_payouts.sql`):
- El cliente paga con Mercado Pago en la **cuenta de Cupo** (`MP_ACCESS_TOKEN`). Lo vendido, menos la comisión REAL de
  Mercado Pago (se guarda en `orders.gateway_fee` al confirmar el pago) y menos el cargo de Cupo, va al **saldo del
  organizador** (`host_balance()`). El saldo de un evento se puede retirar 1 día después de que empieza.
- El organizador guarda su cuenta (`save_payout_account`) y pide el retiro (`request_payout`, mínimo $10.000, uno a la vez).
- Un admin ve los retiros en `#/admin` (`admin_payouts`), le transfiere **a mano** y lo marca (`mark_payout` paid/rejected).
- Si el organizador conecta su Mercado Pago (botón en su perfil, no aparece a admins), sus ventas se cobran con su
  cuenta (split): le caen directo y Cupo recibe su cargo como `marketplace_fee`. Si no, van a su saldo en Cupo.

Edge Functions (Mercado Pago, split de pagos — migración `20261117070000_mp_marketplace.sql`):
- Cada organizador conecta su Mercado Pago (OAuth): `mp-connect` (devuelve la URL de autorización, guarda un `state`
  en `mp_oauth_states`) y `mp-oauth-callback` (cambia el code por tokens y los guarda en `mp_accounts`; vuelve a
  `/?mp=ok#/panel`). `mp_accounts` solo la lee el servidor. Los tokens se renuevan solos (`_shared/mp.ts`).
- `create-order` — body `{slug, code, items:[{ticket_type_id,qty}], name}`. Si el dueño del evento conectó su cuenta,
  crea la preferencia con SU token y `marketplace_fee = platform_fee` (el cargo de Cupo, limpio). Si no está conectado,
  cobra con `MP_ACCESS_TOKEN` (cuenta de Cupo) y la venta suma a su saldo en Cupo.
  Guarda `orders.mp_seller_id`. Responde `{orderId, token, reference, checkoutUrl}`; el navegador redirige ahí.
- Mercado Pago devuelve a `/?o=<orden>&k=<token>&payment_id=...`; el frontend llama `confirm-order`
  con `{paymentId, orderId, token}`.
- `mp-webhook` — aviso `payment`; la `notification_url` lleva `?ref=<referencia>`. Es la fuente de verdad: busca la
  orden, consulta el pago con el token de la cuenta que cobró y llama `finalize_order` (idempotente).
- Secretos: `MP_ACCESS_TOKEN` (cuenta de Cupo), `MP_CLIENT_ID` y `MP_CLIENT_SECRET` (app de Mercado Pago, para OAuth).
  En la app de Mercado Pago, la URL de redirección es `https://xlkyrtjtwyzpmjsdokgn.supabase.co/functions/v1/mp-oauth-callback`.

Comisiones (`calc_fees` en SQL y `fees` en la demo): con `fee_mode = 'buyer'` el comprador paga precio + 8 % de Cupo (redondeado hacia arriba a los $100)
(cargo por servicio, le llega completo a Cupo) y la comisión de Mercado Pago se descuenta del precio de la boleta
(del organizador). Con `'organizer'` el comprador paga el precio exacto y ambas se descuentan del organizador.
La comisión de Mercado Pago es una estimación (3,29 % + $800 + IVA 19 %): confirmarla en el panel de Mercado Pago.

## Reglas
- Secretos (service_role, `MP_ACCESS_TOKEN` de Mercado Pago) solo en
  variables de entorno de las Edge Functions. Nunca en `web/`.
- Activar RLS en todas las tablas. Las RPCs que exponen datos deben ser `security definer` con validaciones.
- Probar primero con las credenciales de **prueba** de Mercado Pago antes de las de producción.
- Los correos se guardan en minúsculas y sin espacios (`norm_email`).

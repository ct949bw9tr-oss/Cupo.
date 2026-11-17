# Cupo — contexto para Claude Code

Cupo es una app de boletería estilo Posh para Barranquilla, Colombia. La gente crea eventos
(públicos o privados), vende boletas y Cupo se queda con el 2 % de cada boleta.

**Meta inmediata:** vender las boletas de la fiesta del dueño en Barranquilla en **diciembre de 2026**.
La v1 solo necesita que esa venta funcione de punta a punta. La plataforma completa para otros
organizadores viene después. Prioriza que funcione y sea seguro sobre agregar funciones.

Habla en español con el dueño. Es estudiante y no es programador de tiempo completo:
explica los pasos manuales (consolas de Supabase/Wompi/Vercel) de forma simple y concreta.

## Stack
- **Frontend:** un solo archivo `web/index.html` (HTML + CSS + JS sin framework, mobile-first, rutas con hash `#/...`).
  Lee la configuración de `web/config.js` (copiar de `config.example.js`; está en .gitignore).
- **Backend:** Supabase (Postgres + Auth por OTP al celular + Storage para flyers + Edge Functions).
- **Pagos:** Wompi (Colombia) con el Widget Checkout (`https://checkout.wompi.co/widget.js`). Moneda COP.
- **Hosting sugerido:** Vercel (sitio estático desde `web/`).

## Estado actual (16 nov 2026)
- **Backend creado** en el proyecto Supabase `cupo` (ref `xlkyrtjtwyzpmjsdokgn`, us-east-1):
  migración `supabase/migrations/20261116190000_cupo_v1.sql` aplicada (tablas, RLS, RPCs, bucket `covers`)
  y Edge Functions `create-order`, `confirm-order`, `wompi-webhook` desplegadas. Flujo probado con SQL.
- La tabla `orders` vieja de un intento anterior quedó en el esquema `archive` (vacía).
- `web/config.js` ya apunta a ese proyecto.
- `demo/index.html` = vista de prueba original con todo simulado (OTP `123456`). Referencia de comportamiento.
- **Pendiente manual:** secretos de Wompi en Supabase (`WOMPI_PUBLIC_KEY`, `WOMPI_INTEGRITY_SECRET`,
  `WOMPI_EVENTS_SECRET`), activar login por celular (proveedor SMS), URL de eventos de Wompi,
  marcar al dueño como admin, publicar `web/` (Vercel) y probar una compra en sandbox.
- Stock: una orden pendiente aparta sus boletas 30 min (`reserved_qty`); el webhook es la fuente de verdad.

## Contrato que el frontend espera (sacado de la demo)

Tablas que se leen/escriben directo: `profiles` (id, name, is_admin), `events`, `ticket_types`, `orders`, `tickets`.

Campos de `events`: id, owner_id, slug, name, starts_at, venue, address, city, description, cover_url,
palette, is_private, access_code, published, allow_transfers, fee_mode ('buyer' | 'organizer'), spotify_url, created_at.
`ticket_types`: id, event_id, name, price, quantity, sold, sales_end, unlock_after (id de otra etapa: se abre cuando esa se agota).
`orders`: id, token, reference (`CUP-AAMMDD-XXXXXXXX`), event_id, buyer_name, buyer_phone, items, qty, subtotal, fee_mode, total, status ('pending' | 'paid' | 'failed').
`tickets`: id, code (`CUP-XXXX-XXXX`), order_id, event_id, ticket_type_id, type_name, holder_name, holder_phone, transfers, price, checked_in_at.

RPCs (`sb.rpc`) — ver implementación de referencia en `demo/index.html`, objeto `RPC`:
`list_public_events`, `get_event(p_slug,p_code)`, `find_private_event(p_code)`, `calc_fees(p_subtotal,p_mode)`,
`get_order(p_order,p_token)`, `event_summary(p_event)`, `check_in(p_event,p_code)`, `my_tickets()`,
`transfer_ticket(p_code,p_phone,p_name)` (rota el código de la boleta), `platform_summary()` (solo admin).

Edge Functions:
- `create-order` — body `{slug, code, items:[{ticket_type_id,qty}], name}`. Valida sesión, evento, código privado,
  disponibilidad y etapas; crea la orden `pending`; calcula la **firma de integridad de Wompi en el servidor**
  (SHA-256 de `reference + amountInCents + currency + secreto_integridad`). Responde
  `{orderId, token, reference, amountInCents, currency, signature, publicKey, redirectUrl}` o `{error}`.
- `confirm-order` — body `{transactionId}`. Consulta la transacción en la API de Wompi y marca la orden.
- **Falta:** un webhook de eventos de Wompi (`transaction.updated`) que verifique el checksum y emita las boletas.
  El webhook debe ser la fuente de verdad; `confirm-order` es solo un atajo para la pantalla de confirmación.
  Emitir boletas debe ser idempotente (no duplicar si llegan dos avisos).

Comisiones (función `fees` en la demo): Cupo 2 % del subtotal; Wompi 2,65 % + $700 COP, más IVA 19 % sobre la comisión de Wompi.
Si `fee_mode = 'buyer'`, el comprador paga todo encima del precio; si es `'organizer'`, se descuenta del organizador.

## Reglas
- Secretos (service_role, llave privada de Wompi, secreto de integridad, secreto de eventos) solo en
  variables de entorno de las Edge Functions. Nunca en `web/`.
- Activar RLS en todas las tablas. Las RPCs que exponen datos deben ser `security definer` con validaciones.
- Probar primero con las llaves de **sandbox** de Wompi (`pub_test_...`) antes de producción.
- Celulares colombianos se normalizan a `57XXXXXXXXXX`.

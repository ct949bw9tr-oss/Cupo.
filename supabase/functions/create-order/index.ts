// Crea una orden pendiente y una "preferencia" de pago en Mercado Pago (Checkout Pro).
// El Access Token de Mercado Pago solo vive aquí (variable MP_ACCESS_TOKEN): nunca llega al navegador.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const mpToken = Deno.env.get("MP_ACCESS_TOKEN");
  if (!mpToken) return json({ error: "Pagos sin configurar todavía." }, 500);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !u?.user) return json({ error: "Entra con tu celular para comprar." }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }

  const { data, error } = await admin.rpc("create_order_internal", {
    p_user: u.user.id,
    p_slug: String(body?.slug ?? ""),
    p_code: body?.code ? String(body.code) : null,
    p_items: Array.isArray(body?.items) ? body.items : [],
    p_name: String(body?.name ?? ""),
  });
  if (error) { console.error(error); return json({ error: "No se pudo crear la orden." }, 500); }
  if (data?.error) return json({ error: data.error });

  const { data: ord } = await admin.from("orders").select("qty, events(name)").eq("id", data.orderId).single();
  const evName = (ord as any)?.events?.name ?? "Cupo";
  const qty = (ord as any)?.qty ?? 1;

  const site = (Deno.env.get("SITE_URL") || req.headers.get("origin") || "").replace(/\/+$/, "");
  const back = `${site}/?o=${data.orderId}&k=${data.token}`;

  const preference = {
    items: [{
      id: data.reference,
      title: `${qty} boleta${qty === 1 ? "" : "s"} · ${evName}`.slice(0, 250),
      quantity: 1,
      unit_price: Number(data.amountInCents) / 100,
      currency_id: "COP",
    }],
    external_reference: data.reference,
    back_urls: { success: back, pending: back, failure: back },
    auto_return: "approved",
    notification_url: `${supabaseUrl}/functions/v1/mp-webhook`,
    statement_descriptor: "CUPO",
    // La orden aparta las boletas 30 minutos: el link de pago vence al mismo tiempo.
    expires: true,
    expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    // Sin pagos en efectivo (tardan días y la reserva dura 30 minutos).
    payment_methods: { excluded_payment_types: [{ id: "ticket" }] },
    metadata: { order_id: data.orderId },
  };

  const res = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mpToken}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": data.reference,
    },
    body: JSON.stringify(preference),
  });
  if (!res.ok) {
    console.error("Mercado Pago preference error", res.status, await res.text());
    // Libera las boletas apartadas por esta orden
    await admin.rpc("finalize_order", { p_reference: data.reference, p_tx_id: "", p_status: "ERROR", p_amount_in_cents: 0 });
    return json({ error: "No se pudo iniciar el pago. Intenta otra vez." }, 502);
  }
  const pref = await res.json();
  const checkoutUrl = mpToken.startsWith("TEST-") ? (pref.sandbox_init_point || pref.init_point) : pref.init_point;

  return json({ orderId: data.orderId, token: data.token, reference: data.reference, checkoutUrl });
});

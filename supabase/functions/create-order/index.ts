// Crea una orden pendiente y una "preferencia" de pago en Mercado Pago (Checkout Pro).
// Split de pagos: si el organizador conectó su Mercado Pago, la preferencia se crea con SU token,
// la plata le cae a él y Cupo cobra su cargo por servicio como marketplace_fee.
// Los eventos de un admin de Cupo sin cuenta conectada se cobran con la cuenta de Cupo (MP_ACCESS_TOKEN).
import { adminClient, MP_API, sellerToken } from "../_shared/mp.ts";

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

  const admin = adminClient();
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !u?.user) return json({ error: "Entra con tu correo para comprar." }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }
  const slug = String(body?.slug ?? "");

  // ¿Con qué cuenta de Mercado Pago se cobra este evento?
  const { data: ev } = await admin.from("events").select("id, name, owner_id, profiles(is_admin)").eq("slug", slug).maybeSingle();
  if (!ev) return json({ error: "Este evento no existe." });
  let mpToken = await sellerToken(admin, ev.owner_id);
  const split = !!mpToken;
  if (!mpToken) {
    if (!(ev as any).profiles?.is_admin) {
      return json({ error: "El organizador todavía no ha conectado su Mercado Pago. Intenta más tarde." });
    }
    mpToken = Deno.env.get("MP_ACCESS_TOKEN") ?? null;
  }
  if (!mpToken) return json({ error: "Pagos sin configurar todavía." }, 500);

  const { data, error } = await admin.rpc("create_order_internal", {
    p_user: u.user.id,
    p_slug: slug,
    p_code: body?.code ? String(body.code) : null,
    p_items: Array.isArray(body?.items) ? body.items : [],
    p_name: String(body?.name ?? ""),
  });
  if (error) { console.error(error); return json({ error: "No se pudo crear la orden." }, 500); }
  if (data?.error) return json({ error: data.error });

  const { data: ord } = await admin.from("orders")
    .update({ mp_seller_id: split ? ev.owner_id : null })
    .eq("id", data.orderId).select("qty, platform_fee").single();
  const qty = ord?.qty ?? 1;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const site = (Deno.env.get("SITE_URL") || req.headers.get("origin") || "").replace(/\/+$/, "");
  const back = `${site}/?o=${data.orderId}&k=${data.token}`;

  const preference: Record<string, unknown> = {
    items: [{
      id: data.reference,
      title: `${qty} boleta${qty === 1 ? "" : "s"} · ${ev.name}`.slice(0, 250),
      quantity: 1,
      unit_price: Number(data.amountInCents) / 100,
      currency_id: "COP",
    }],
    external_reference: data.reference,
    back_urls: { success: back, pending: back, failure: back },
    auto_return: "approved",
    notification_url: `${supabaseUrl}/functions/v1/mp-webhook?ref=${encodeURIComponent(data.reference)}`,
    statement_descriptor: "CUPO",
    // La orden aparta las boletas 30 minutos: el link de pago vence al mismo tiempo.
    expires: true,
    expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    // Sin pagos en efectivo (tardan días y la reserva dura 30 minutos).
    payment_methods: { excluded_payment_types: [{ id: "ticket" }] },
    metadata: { order_id: data.orderId },
  };
  // Cargo por servicio de Cupo: le llega limpio a la cuenta de Cupo
  if (split) preference.marketplace_fee = ord?.platform_fee ?? 0;

  const res = await fetch(`${MP_API}/checkout/preferences`, {
    method: "POST",
    headers: { Authorization: `Bearer ${mpToken}`, "Content-Type": "application/json", "X-Idempotency-Key": data.reference },
    body: JSON.stringify(preference),
  });
  if (!res.ok) {
    console.error("Mercado Pago preference error", res.status, await res.text());
    await admin.rpc("finalize_order", { p_reference: data.reference, p_tx_id: "", p_status: "ERROR", p_amount_in_cents: 0 });
    return json({ error: "No se pudo iniciar el pago. Intenta otra vez." }, 502);
  }
  const pref = await res.json();
  const checkoutUrl = mpToken.startsWith("TEST-") ? (pref.sandbox_init_point || pref.init_point) : pref.init_point;
  return json({ orderId: data.orderId, token: data.token, reference: data.reference, checkoutUrl });
});

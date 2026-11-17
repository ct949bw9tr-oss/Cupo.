// Cobra una orden con el formulario de Mercado Pago que va DENTRO de Cupo (Payment Brick).
// Body: { orderId, token, formData } — formData es lo que entrega el Brick en onSubmit.
// - Tarjeta (crédito/débito): se cobra aquí mismo. Si el banco pide verificación (3DS),
//   responde { status:'pending', challenge:{ url, creq } } y el navegador la muestra.
// - PSE: responde { redirectUrl } con la página del banco (PSE siempre pasa por el banco).
// El monto SIEMPRE sale de la orden, nunca del navegador. La fuente de verdad sigue siendo mp-webhook.
import { adminClient, MP_API, syncOrderPayment, tokenForOrder } from "../_shared/mp.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESERVE_MIN = 30;

// Mensajes claros para los rechazos más comunes
const REJECT: Record<string, string> = {
  cc_rejected_insufficient_amount: "La tarjeta no tiene fondos suficientes.",
  cc_rejected_bad_filled_security_code: "El código de seguridad (CVV) no es correcto.",
  cc_rejected_bad_filled_date: "La fecha de vencimiento no es correcta.",
  cc_rejected_bad_filled_card_number: "Revisa el número de la tarjeta.",
  cc_rejected_bad_filled_other: "Revisa los datos de la tarjeta.",
  cc_rejected_call_for_authorize: "Tu banco pide que autorices este pago. Llámalos o usa otra tarjeta.",
  cc_rejected_card_disabled: "La tarjeta no está activada para compras por internet. Actívala con tu banco o usa otra.",
  cc_rejected_duplicated_payment: "Ya hiciste un pago igual hace un momento. Revisa tus boletas.",
  cc_rejected_high_risk: "El pago fue rechazado por seguridad. Prueba con otra tarjeta o con PSE.",
  cc_rejected_max_attempts: "Llegaste al límite de intentos con esta tarjeta. Usa otra o PSE.",
  cc_rejected_blacklist: "No se pudo procesar esta tarjeta. Usa otra o PSE.",
  cc_rejected_3ds_challenge: "No se completó la verificación del banco. Intenta otra vez.",
  cc_rejected_other_reason: "Tu banco rechazó el pago. Prueba con otra tarjeta o con PSE.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let b: any = {};
  try { b = await req.json(); } catch { /* vacío */ }
  const orderId = String(b?.orderId ?? ""), token = String(b?.token ?? "");
  const fd = b?.formData ?? {};
  if (!UUID.test(orderId) || !UUID.test(token) || typeof fd !== "object") return json({ error: "Solicitud inválida." }, 400);

  const admin = adminClient();
  const { data: order } = await admin.from("orders")
    .select("id, reference, total, status, platform_fee, mp_seller_id, created_at, buyer_email, qty, event_id")
    .eq("id", orderId).eq("token", token).maybeSingle();
  if (!order) return json({ error: "Orden no encontrada." }, 404);
  if (order.status === "paid") return json({ status: "approved" });
  if (Date.now() - new Date(order.created_at).getTime() > RESERVE_MIN * 60 * 1000) {
    return json({ error: "Tu reserva venció (30 minutos). Vuelve a elegir tus boletas." }, 410);
  }

  const mpToken = await tokenForOrder(admin, order);
  if (!mpToken) return json({ error: "Pagos sin configurar todavía." }, 500);
  const { data: ev } = await admin.from("events").select("name").eq("id", order.event_id).maybeSingle();

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const site = (Deno.env.get("SITE_URL") || req.headers.get("origin") || "").replace(/\/+$/, "");
  const method = String(fd.payment_method_id ?? "");
  const email = String(fd.payer?.email || order.buyer_email || "").trim().toLowerCase();

  const payment: Record<string, unknown> = {
    transaction_amount: Number(order.total),
    description: `${order.qty} boleta${order.qty === 1 ? "" : "s"} · ${ev?.name ?? "Cupo"}`.slice(0, 250),
    external_reference: order.reference,
    notification_url: `${supabaseUrl}/functions/v1/mp-webhook?ref=${encodeURIComponent(order.reference)}`,
    statement_descriptor: "CUPO",
    payment_method_id: method,
    metadata: { order_id: order.id },
  };
  if (order.mp_seller_id) payment.application_fee = Number(order.platform_fee ?? 0);   // cargo de Cupo (split)

  if (method === "pse") {
    const p = fd.payer ?? {};
    if (!fd.transaction_details?.financial_institution) return json({ error: "Escoge tu banco." }, 400);
    payment.payer = {
      email,
      entity_type: p.entity_type || "individual",
      first_name: p.first_name, last_name: p.last_name,
      identification: p.identification,
      address: p.address,
      ...(p.phone ? { phone: p.phone } : {}),
    };
    payment.transaction_details = { financial_institution: String(fd.transaction_details.financial_institution) };
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "127.0.0.1";
    payment.additional_info = { ip_address: ip };
    payment.callback_url = `${site}/?o=${order.id}&k=${token}`;
  } else {
    if (!fd.token) return json({ error: "Faltan los datos de la tarjeta." }, 400);
    payment.token = String(fd.token);
    payment.installments = Math.max(1, Number(fd.installments) || 1);
    if (fd.issuer_id) payment.issuer_id = Number(fd.issuer_id) || fd.issuer_id;
    payment.payer = { email, ...(fd.payer?.identification?.number ? { identification: fd.payer.identification } : {}) };
    payment.three_d_secure_mode = "optional";
  }

  const res = await fetch(`${MP_API}/v1/payments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mpToken}`,
      "Content-Type": "application/json",
      // Un intento por token de tarjeta (o por clic en PSE): evita cobrar dos veces el mismo intento
      "X-Idempotency-Key": `${order.reference}-${String(fd.token || crypto.randomUUID()).slice(0, 60)}`,
    },
    body: JSON.stringify(payment),
  });
  const p = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Mercado Pago payment error", res.status, JSON.stringify(p));
    const cause = p?.cause?.[0]?.description || p?.message || "";
    return json({ error: "Mercado Pago no aceptó el pago. Revisa los datos e intenta otra vez.", detail: String(cause).slice(0, 200) }, 400);
  }

  const out: Record<string, unknown> = { paymentId: String(p.id), status: p.status, statusDetail: p.status_detail };
  if (p.status === "approved") {
    await syncOrderPayment(admin, order, String(p.id));   // crea las boletas ya (el webhook también lo hace)
  } else if (p.status === "rejected") {
    out.error = REJECT[p.status_detail] ?? "El pago fue rechazado. Prueba con otro medio de pago.";
  } else if (p.status_detail === "pending_challenge" && p.three_ds_info?.external_resource_url) {
    out.challenge = { url: p.three_ds_info.external_resource_url, creq: p.three_ds_info.creq };
  } else if (method === "pse") {
    const url = p.transaction_details?.external_resource_url;
    if (!url) return json({ error: "PSE no respondió. Intenta otra vez o usa tarjeta." }, 502);
    out.redirectUrl = url;
  }
  return json(out);
});

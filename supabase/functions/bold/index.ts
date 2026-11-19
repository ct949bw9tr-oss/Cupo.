// Bold (pasarela colombiana): botón de pagos con tarjeta débito/crédito, PSE, Nequi, etc.
// Una sola función con tres usos (verify_jwt = false):
//  1. { action: "sign", orderId, token } -> firma de integridad para abrir el checkout de Bold
//     (SHA-256 de referencia + monto + moneda + llave secreta). El monto sale de la orden, nunca del navegador.
//  2. { action: "confirm", reference }    -> el navegador vuelve de Bold y pide confirmar.
//  3. Webhook de Bold (cualquier POST que traiga una referencia CUP-...).
// En 2 y 3 NUNCA se confía en lo que llega: se consulta el pago a la API de Bold con la referencia
// y finalize_order exige que el monto sea el de la orden.
// Secretos: BOLD_API_KEY (llave de identidad) y BOLD_SECRET_KEY (llave secreta).
import { adminClient } from "../_shared/mp.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /CUP-\d{6}-[A-Z0-9]{8}/;
const STATUS: Record<string, string> = { APPROVED: "APPROVED", REJECTED: "DECLINED", FAILED: "DECLINED", VOIDED: "VOIDED" };

async function sha256(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const apiKey = Deno.env.get("BOLD_API_KEY") ?? "", secret = Deno.env.get("BOLD_SECRET_KEY") ?? "";
  if (!apiKey || !secret) return json({ error: "Bold todavía no está configurado." }, 503);

  const raw = await req.text();
  let b: any = {};
  try { b = JSON.parse(raw); } catch { /* cuerpo no JSON */ }
  const admin = adminClient();

  // 1) Firma para abrir el checkout
  if (b?.action === "sign") {
    const orderId = String(b.orderId ?? ""), token = String(b.token ?? "");
    if (!UUID.test(orderId) || !UUID.test(token)) return json({ error: "Solicitud inválida." }, 400);
    const { data: o } = await admin.from("orders").select("reference, total, status, created_at")
      .eq("id", orderId).eq("token", token).maybeSingle();
    if (!o) return json({ error: "Orden no encontrada." }, 404);
    if (o.status === "paid") return json({ error: "Esta orden ya está pagada." }, 409);
    if (Date.now() - new Date(o.created_at).getTime() > 30 * 60 * 1000) return json({ error: "Tu reserva venció. Vuelve a elegir tus boletas." }, 410);
    const amount = String(Math.round(Number(o.total)));
    const integritySignature = await sha256(`${o.reference}${amount}COP${secret}`);
    return json({ apiKey, orderId: o.reference, amount, currency: "COP", integritySignature });
  }

  // 2) y 3) Confirmación: buscar la referencia (del navegador o del webhook) y preguntarle a Bold
  const reference = (String(b?.reference ?? "").match(REF) ?? raw.match(REF) ?? [])[0];
  if (!reference) return json({ ok: true, ignorado: true });

  const res = await fetch(`https://payments.api.bold.co/v2/payment-voucher/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `x-api-key ${apiKey}` },
  });
  const v = await res.json().catch(() => null);
  if (!res.ok || !v) { console.error("bold consulta falló", reference, res.status, JSON.stringify(v)?.slice(0, 400)); return json({ error: "No se pudo consultar Bold." }, 502); }

  const st = String(v.payment_status ?? v.status ?? "").toUpperCase();
  const amount = Number(v.total ?? v.amount?.total ?? v.amount ?? NaN);
  const status = STATUS[st] ?? "PENDING";
  if (status === "APPROVED" && !Number.isFinite(amount)) {
    console.error("bold sin monto en la respuesta", reference, JSON.stringify(v).slice(0, 400));
    return json({ error: "Respuesta de Bold sin monto." }, 502);
  }
  const { data, error } = await admin.rpc("finalize_order", {
    p_reference: reference,
    p_tx_id: `bold:${v.transaction_id ?? v.id ?? reference}`,
    p_status: status,
    p_amount_in_cents: Math.round((Number.isFinite(amount) ? amount : 0) * 100),
  });
  if (error) { console.error(error); return json({ error: "No se pudo confirmar." }, 500); }
  if (status !== "APPROVED") {
    console.log("bold", reference, st, v.payment_method, JSON.stringify(v).slice(0, 300));
    await admin.from("orders").update({ wompi_status: `BOLD:${st}`.slice(0, 120) }).eq("reference", reference).neq("status", "paid");
  }
  return json({ status, result: data });
});

// Se llama cuando Mercado Pago devuelve al comprador a Cupo (?o=orden&k=token&payment_id=...).
// Es solo un atajo para la pantalla de confirmación: la fuente de verdad es mp-webhook.
import { adminClient, syncOrderPayment } from "../_shared/mp.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let b: any = {};
  try { b = await req.json(); } catch { /* vacío */ }
  const paymentId = String(b?.paymentId ?? ""), orderId = String(b?.orderId ?? ""), token = String(b?.token ?? "");
  if (!/^\d{5,30}$/.test(paymentId) || !UUID.test(orderId) || !UUID.test(token)) return json({ error: "Solicitud inválida." }, 400);

  const admin = adminClient();
  const { data: order } = await admin.from("orders").select("id, reference, mp_seller_id")
    .eq("id", orderId).eq("token", token).maybeSingle();
  if (!order) return json({ error: "Orden no encontrada." }, 404);

  const r = await syncOrderPayment(admin, order, paymentId);
  return json(r.ok ? { status: r.status, ...r.result } : { error: r.error }, r.http);
});

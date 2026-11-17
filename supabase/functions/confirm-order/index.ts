// Se llama cuando Mercado Pago devuelve al comprador a Cupo (?payment_id=...).
// Es solo un atajo para la pantalla de confirmación: la fuente de verdad es mp-webhook.
import { syncPayment } from "../_shared/mp.ts";

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

  let id = "";
  try { id = String((await req.json())?.paymentId ?? ""); } catch { /* vacío */ }
  if (!/^\d{5,30}$/.test(id)) return json({ error: "Pago inválido." }, 400);

  const r = await syncPayment(id);
  return json(r.ok ? { status: r.status, ...r.result } : { error: r.error }, r.http);
});

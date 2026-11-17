// Avisos de Mercado Pago (tipo "payment"). Es la fuente de verdad: aunque el comprador
// cierre el navegador después de pagar, aquí se emiten sus boletas.
// Del aviso solo se toma el número del pago; el estado y el monto se consultan
// directamente a Mercado Pago con el Access Token, así un aviso falso no puede emitir boletas.
// finalize_order es idempotente: si llegan dos avisos, las boletas se emiten una sola vez.
import { syncPayment } from "../_shared/mp.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const url = new URL(req.url);
  let body: any = {};
  try { body = await req.json(); } catch { /* algunos avisos vienen sin cuerpo */ }

  const type = body?.type ?? body?.topic ?? url.searchParams.get("type") ?? url.searchParams.get("topic");
  const id = String(body?.data?.id ?? url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? "");
  if (type !== "payment" || !/^\d{5,30}$/.test(id)) return new Response("ignorado");

  const r = await syncPayment(id);
  if (!r.ok && r.http >= 500) return new Response("error", { status: 500 }); // Mercado Pago reintenta
  return new Response("ok");
});

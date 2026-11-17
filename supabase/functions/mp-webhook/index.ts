// Avisos de Mercado Pago (tipo "payment"). Es la fuente de verdad: aunque el comprador
// cierre el navegador después de pagar, aquí se emiten sus boletas.
// La URL de aviso de cada orden lleva su referencia (?ref=CUP-...). Del aviso solo se toma el
// número del pago; el estado y el monto se consultan a Mercado Pago con el token de la cuenta que
// cobró, así un aviso falso no puede emitir boletas. finalize_order es idempotente.
import { adminClient, syncOrderPayment } from "../_shared/mp.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const url = new URL(req.url);
  let body: any = {};
  try { body = await req.json(); } catch { /* algunos avisos vienen sin cuerpo */ }

  const type = body?.type ?? body?.topic ?? url.searchParams.get("type") ?? url.searchParams.get("topic");
  const id = String(body?.data?.id ?? url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? "");
  const ref = url.searchParams.get("ref") ?? "";
  if (type !== "payment" || !/^\d{5,30}$/.test(id) || !/^CUP-\d{6}-[A-Z0-9]{8}$/.test(ref)) return new Response("ignorado");

  const admin = adminClient();
  const { data: order } = await admin.from("orders").select("id, reference, mp_seller_id").eq("reference", ref).maybeSingle();
  if (!order) return new Response("ignorado");

  const r = await syncOrderPayment(admin, order, id);
  if (!r.ok && r.http >= 500) return new Response("error", { status: 500 }); // Mercado Pago reintenta
  return new Response("ok");
});

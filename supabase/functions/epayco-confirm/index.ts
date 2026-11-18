// Confirmación de pagos de ePayco / Davipay (checkout de ePayco: Apple Pay, tarjetas débito y crédito, PSE, Nequi).
// - ePayco llama esta URL (POST, "url de confirmación") cuando cambia el estado de un pago: es la fuente de verdad.
// - El navegador también la llama (POST { ref_payco }) al volver del checkout, para mostrar la boleta de una vez.
// Nunca se confía en lo que llega: con la referencia de ePayco se consulta el pago a ePayco y se revisa que la
// factura sea una orden de Cupo, que la moneda sea COP y que el monto sea el de la orden (finalize_order lo exige).
// Si viene firma (x_signature), también se verifica con EPAYCO_P_CUST_ID y EPAYCO_P_KEY.
// Se despliega con verify_jwt = false.
import { adminClient } from "../_shared/mp.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// x_cod_response de ePayco -> estados que entiende finalize_order
const STATUS: Record<string, string> = { "1": "APPROVED", "2": "DECLINED", "4": "DECLINED", "6": "VOIDED", "3": "PENDING", "7": "PENDING", "8": "PENDING" };
const REF = /^CUP-\d{6}-[A-Z0-9]{8}$/;

async function sha256(s: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readParams(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((v, k) => { out[k] = v; });
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    try {
      if (ct.includes("application/json")) Object.assign(out, await req.json());
      else (await req.formData()).forEach((v, k) => { out[k] = String(v); });
    } catch { /* cuerpo vacío */ }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const q = await readParams(req);
  const refPayco = String(q.x_ref_payco || q.ref_payco || "").trim();
  if (!/^[\w-]{4,64}$/.test(refPayco)) return json({ error: "Referencia inválida." }, 400);

  // Si ePayco mandó firma, debe cuadrar (protege la URL de confirmación de avisos falsos)
  if (q.x_signature) {
    const cust = Deno.env.get("EPAYCO_P_CUST_ID") ?? "", key = Deno.env.get("EPAYCO_P_KEY") ?? "";
    if (cust && key) {
      const sig = await sha256([cust, key, q.x_ref_payco, q.x_transaction_id, q.x_amount, q.x_currency_code].join("^"));
      if (sig !== String(q.x_signature).toLowerCase()) { console.error("epayco firma inválida", refPayco); return json({ error: "Firma inválida." }, 400); }
    }
  }

  // Estado real: se consulta a ePayco con su referencia
  const res = await fetch(`https://secure.epayco.co/validation/v1/reference/${encodeURIComponent(refPayco)}`);
  const body = await res.json().catch(() => null);
  const d = body?.data;
  if (!res.ok || !d) { console.error("epayco consulta falló", refPayco, res.status, JSON.stringify(body)?.slice(0, 300)); return json({ error: "No se pudo consultar ePayco." }, 502); }

  const reference = String(d.x_id_invoice || d.x_id_factura || "");
  if (!REF.test(reference) || String(d.x_currency_code).toUpperCase() !== "COP") return json({ error: "El pago no corresponde a Cupo." }, 400);

  const admin = adminClient();
  const { data: order } = await admin.from("orders").select("id, status").eq("reference", reference).maybeSingle();
  if (!order) return json({ error: "Orden no encontrada." }, 404);

  const code = String(d.x_cod_response ?? d.x_cod_transaction_state ?? "");
  const status = STATUS[code] ?? "PENDING";
  const { data, error } = await admin.rpc("finalize_order", {
    p_reference: reference,
    p_tx_id: `epayco:${refPayco}`,
    p_status: status,
    p_amount_in_cents: Math.round(Number(d.x_amount) * 100),
  });
  if (error) { console.error(error); return json({ error: "No se pudo confirmar." }, 500); }
  if (status !== "APPROVED") {
    console.log("epayco", reference, refPayco, code, d.x_response, d.x_response_reason_text, d.x_franchise);
    await admin.from("orders").update({ wompi_status: `EPAYCO:${code}:${String(d.x_response_reason_text ?? "").slice(0, 80)}` })
      .eq("id", order.id).neq("status", "paid");
  }
  return json({ status, result: data });
});

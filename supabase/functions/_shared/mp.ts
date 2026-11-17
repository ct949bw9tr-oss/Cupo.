// Consulta un pago directamente en la API de Mercado Pago (con el Access Token privado)
// y lo pasa a finalize_order. Nunca se confía en lo que diga el navegador o el aviso:
// solo se usa el número del pago para preguntarle a Mercado Pago.
import { createClient } from "npm:@supabase/supabase-js@2";

// Estados de Mercado Pago -> estados que entiende finalize_order
const STATUS: Record<string, string> = {
  approved: "APPROVED",
  rejected: "DECLINED",
  cancelled: "VOIDED",
};

export async function syncPayment(paymentId: string) {
  const token = Deno.env.get("MP_ACCESS_TOKEN");
  if (!token) return { ok: false, http: 500, error: "Pagos sin configurar todavía." };

  const res = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return { ok: false, http: 404, error: "Mercado Pago no encontró el pago." };
  if (!res.ok) return { ok: false, http: 502, error: "No se pudo consultar Mercado Pago." };

  const p = await res.json();
  if (!p?.external_reference || p.currency_id !== "COP") return { ok: false, http: 400, error: "Pago inválido." };

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.rpc("finalize_order", {
    p_reference: String(p.external_reference),
    p_tx_id: String(p.id),
    p_status: STATUS[p.status] ?? String(p.status || "pending").toUpperCase(),
    p_amount_in_cents: Math.round(Number(p.transaction_amount) * 100),
  });
  if (error) { console.error(error); return { ok: false, http: 500, error: "No se pudo confirmar." }; }
  return { ok: true, http: 200, status: p.status, result: data };
}

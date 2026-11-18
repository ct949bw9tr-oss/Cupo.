// Utilidades de Mercado Pago compartidas por las Edge Functions.
// - Cada orden se cobra con la cuenta del organizador (split de pagos) o con la de Cupo.
// - El estado de un pago SIEMPRE se consulta a Mercado Pago con el token de la cuenta que cobró:
//   nunca se confía en lo que diga el navegador o el aviso.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const MP_API = "https://api.mercadopago.com";

export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

// Estados de Mercado Pago -> estados que entiende finalize_order
const STATUS: Record<string, string> = { approved: "APPROVED", rejected: "DECLINED", cancelled: "VOIDED" };

// Token de la cuenta de Mercado Pago del organizador; lo renueva si está por vencer.
export async function sellerToken(admin: SupabaseClient, ownerId: string): Promise<string | null> {
  const { data: acc } = await admin.from("mp_accounts").select("*").eq("owner_id", ownerId).maybeSingle();
  if (!acc) return null;
  const soon = Date.now() + 24 * 3600 * 1000;
  if (acc.expires_at && new Date(acc.expires_at).getTime() < soon && acc.refresh_token) {
    const res = await fetch(`${MP_API}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: Deno.env.get("MP_CLIENT_ID"),
        client_secret: Deno.env.get("MP_CLIENT_SECRET"),
        grant_type: "refresh_token",
        refresh_token: acc.refresh_token,
      }),
    });
    if (res.ok) {
      const t = await res.json();
      await admin.from("mp_accounts").update({
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? acc.refresh_token,
        public_key: t.public_key ?? acc.public_key,
        expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
      }).eq("owner_id", ownerId);
      return t.access_token;
    }
    console.error("No se pudo renovar el token de Mercado Pago", ownerId, res.status, await res.text());
  }
  return acc.access_token;
}

// Token con el que se cobró (o se cobra) una orden
export async function tokenForOrder(admin: SupabaseClient, order: { mp_seller_id: string | null }) {
  if (order.mp_seller_id) return await sellerToken(admin, order.mp_seller_id);
  return Deno.env.get("MP_ACCESS_TOKEN") ?? null;
}

type Order = { id: string; reference: string; mp_seller_id: string | null };

// Consulta el pago en Mercado Pago y actualiza la orden (finalize_order es idempotente).
export async function syncOrderPayment(admin: SupabaseClient, order: Order, paymentId: string) {
  const token = await tokenForOrder(admin, order);
  if (!token) return { ok: false, http: 500, error: "Pagos sin configurar todavía." };

  const res = await fetch(`${MP_API}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return { ok: false, http: 404, error: "Mercado Pago no encontró el pago." };
  if (!res.ok) return { ok: false, http: 502, error: "No se pudo consultar Mercado Pago." };

  const p = await res.json();
  if (p?.external_reference !== order.reference || p.currency_id !== "COP") {
    return { ok: false, http: 400, error: "El pago no corresponde a esta orden." };
  }
  const { data, error } = await admin.rpc("finalize_order", {
    p_reference: order.reference,
    p_tx_id: String(p.id),
    p_status: STATUS[p.status] ?? String(p.status || "pending").toUpperCase(),
    p_amount_in_cents: Math.round(Number(p.transaction_amount) * 100),
  });
  if (error) { console.error(error); return { ok: false, http: 500, error: "No se pudo confirmar." }; }
  // Motivo exacto de rechazos y pendientes (p. ej. cc_rejected_high_risk) para poder diagnosticar
  if (p.status !== "approved") {
    console.log("pago", order.reference, p.id, p.payment_method_id, p.payment_type_id, p.status, p.status_detail);
    await admin.from("orders").update({
      wompi_status: `${String(p.status).toUpperCase()}:${p.status_detail ?? ""}:${p.payment_method_id ?? ""}`.slice(0, 120),
    }).eq("id", order.id).neq("status", "paid");
  }
  // Cobrado en la cuenta de Cupo: guarda la comisión REAL de Mercado Pago (lo que no llegó neto),
  // así el saldo del organizador es exacto.
  const net = Number(p?.transaction_details?.net_received_amount);
  if (p.status === "approved" && !order.mp_seller_id && Number.isFinite(net) && net > 0) {
    const fee = Math.max(0, Math.round(Number(p.transaction_amount) - net));
    const { error: feeErr } = await admin.from("orders").update({ gateway_fee: fee }).eq("id", order.id);
    if (feeErr) console.error("No se pudo guardar la comisión real", feeErr);
  }
  return { ok: true, http: 200, status: p.status, result: data };
}

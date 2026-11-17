// Se llama cuando Wompi devuelve al comprador a Cupo (?id=transacción).
// No confía en el navegador: consulta la transacción directamente a Wompi.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const wompiBase = () =>
  (Deno.env.get("WOMPI_PUBLIC_KEY") || "").startsWith("pub_prod_")
    ? "https://production.wompi.co/v1"
    : "https://sandbox.wompi.co/v1";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let txId = "";
  try { txId = String((await req.json())?.transactionId ?? ""); } catch { /* vacío */ }
  if (!/^[\w-]{5,80}$/.test(txId)) return json({ error: "Transacción inválida." }, 400);

  const res = await fetch(`${wompiBase()}/transactions/${encodeURIComponent(txId)}`);
  if (!res.ok) return json({ error: "Wompi no encontró la transacción." }, 404);
  const tx = (await res.json())?.data;
  if (!tx?.reference || tx.currency !== "COP") return json({ error: "Transacción inválida." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.rpc("finalize_order", {
    p_reference: tx.reference, p_tx_id: tx.id, p_status: tx.status, p_amount_in_cents: tx.amount_in_cents,
  });
  if (error) { console.error(error); return json({ error: "No se pudo confirmar." }, 500); }
  return json({ status: tx.status, ...data });
});

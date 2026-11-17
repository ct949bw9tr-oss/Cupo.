// Webhook de eventos de Wompi (transaction.updated). Es la fuente de verdad:
// aunque el comprador cierre el navegador, aquí se emiten sus boletas.
import { createClient } from "npm:@supabase/supabase-js@2";

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const pick = (obj: any, path: string) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const secret = Deno.env.get("WOMPI_EVENTS_SECRET");
  if (!secret) return new Response("sin configurar", { status: 500 });

  let ev: any;
  try { ev = await req.json(); } catch { return new Response("json inválido", { status: 400 }); }

  // Verificación del checksum según la documentación de Wompi
  const props: string[] = ev?.signature?.properties ?? [];
  const concat = props.map((p) => String(pick(ev.data, p) ?? "")).join("") + String(ev?.timestamp ?? "") + secret;
  const expected = await sha256(concat);
  const given = String(ev?.signature?.checksum ?? "").toLowerCase();
  if (!props.length || expected !== given) return new Response("firma inválida", { status: 401 });

  if (ev.event !== "transaction.updated") return new Response("ignorado");
  const tx = ev.data?.transaction;
  if (!tx?.reference || tx.currency !== "COP") return new Response("ignorado");

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { error } = await admin.rpc("finalize_order", {
    p_reference: tx.reference, p_tx_id: tx.id, p_status: tx.status, p_amount_in_cents: tx.amount_in_cents,
  });
  if (error) { console.error(error); return new Response("error", { status: 500 }); } // Wompi reintenta
  return new Response("ok");
});

// Crea una orden pendiente y devuelve lo que necesita el Widget de Wompi.
// La firma de integridad se calcula aquí: el secreto nunca llega al navegador.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const publicKey = Deno.env.get("WOMPI_PUBLIC_KEY");
  const integrity = Deno.env.get("WOMPI_INTEGRITY_SECRET");
  if (!publicKey || !integrity) return json({ error: "Pagos sin configurar todavía." }, 500);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !u?.user) return json({ error: "Entra con tu celular para comprar." }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Solicitud inválida." }, 400); }

  const { data, error } = await admin.rpc("create_order_internal", {
    p_user: u.user.id,
    p_slug: String(body?.slug ?? ""),
    p_code: body?.code ? String(body.code) : null,
    p_items: Array.isArray(body?.items) ? body.items : [],
    p_name: String(body?.name ?? ""),
  });
  if (error) { console.error(error); return json({ error: "No se pudo crear la orden." }, 500); }
  if (data?.error) return json({ error: data.error });

  const signature = await sha256(`${data.reference}${data.amountInCents}${data.currency}${integrity}`);
  const site = (Deno.env.get("SITE_URL") || req.headers.get("origin") || "").replace(/\/+$/, "");
  const redirectUrl = `${site}/?o=${data.orderId}&k=${data.token}`;

  return json({ ...data, signature, publicKey, redirectUrl });
});

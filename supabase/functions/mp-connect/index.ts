// Inicia la conexión de la cuenta de Mercado Pago de un organizador (OAuth).
// Devuelve la URL de autorización de Mercado Pago; al aceptar, Mercado Pago vuelve a mp-oauth-callback.
import { adminClient } from "../_shared/mp.ts";

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

  const clientId = Deno.env.get("MP_CLIENT_ID");
  if (!clientId || !Deno.env.get("MP_CLIENT_SECRET")) return json({ error: "La conexión con Mercado Pago no está configurada todavía." }, 500);

  const admin = adminClient();
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error } = await admin.auth.getUser(jwt);
  if (error || !u?.user) return json({ error: "Entra a tu cuenta primero." }, 401);

  // Limpia intentos viejos y guarda uno nuevo (vale 15 minutos)
  await admin.from("mp_oauth_states").delete().lt("created_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());
  const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const { error: insErr } = await admin.from("mp_oauth_states").insert({ state, owner_id: u.user.id });
  if (insErr) { console.error(insErr); return json({ error: "No se pudo iniciar la conexión." }, 500); }

  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/mp-oauth-callback`;
  const url = new URL("https://auth.mercadopago.com/authorization");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("platform_id", "mp");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  return json({ url: url.toString() });
});

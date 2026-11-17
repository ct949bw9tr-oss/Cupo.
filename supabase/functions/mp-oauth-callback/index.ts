// Regreso desde Mercado Pago después de que el organizador autoriza a Cupo (OAuth).
// Cambia el "code" por los tokens de SU cuenta y los guarda en mp_accounts (solo el servidor los lee).
import { adminClient, MP_API } from "../_shared/mp.ts";

const site = () => (Deno.env.get("SITE_URL") || "https://cupo-beryl.vercel.app").replace(/\/+$/, "");
const back = (result: string) => Response.redirect(`${site()}/?mp=${result}#/panel`, 302);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !/^[a-f0-9]{64}$/.test(state)) return back("error");

  const admin = adminClient();
  const { data: st } = await admin.from("mp_oauth_states").select("*").eq("state", state).maybeSingle();
  await admin.from("mp_oauth_states").delete().eq("state", state); // un solo uso
  if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60 * 1000) return back("expired");

  const res = await fetch(`${MP_API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: Deno.env.get("MP_CLIENT_ID"),
      client_secret: Deno.env.get("MP_CLIENT_SECRET"),
      grant_type: "authorization_code",
      code,
      redirect_uri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/mp-oauth-callback`,
    }),
  });
  if (!res.ok) { console.error("OAuth Mercado Pago", res.status, await res.text()); return back("error"); }
  const t = await res.json();
  if (!t?.access_token || !t?.user_id) return back("error");

  const { error } = await admin.from("mp_accounts").upsert({
    owner_id: st.owner_id,
    mp_user_id: String(t.user_id),
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? null,
    public_key: t.public_key ?? null,
    expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
    connected_at: new Date().toISOString(),
  });
  if (error) { console.error(error); return back("error"); }
  return back("ok");
});

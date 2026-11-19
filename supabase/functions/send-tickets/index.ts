// Reenvía por correo las boletas de un evento que todavía no se han mandado (email_sent_at vacío).
// Lo usa el organizador desde su panel. Solo el dueño del evento o un admin. Body: { eventId }.
import { adminClient } from "../_shared/mp.ts";
import { sendTicketsEmail } from "../_shared/email.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = adminClient();
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(jwt).catch(() => ({ data: null as any }));
  if (!u?.user) return json({ error: "Entra con tu correo." }, 401);

  let b: any = {};
  try { b = await req.json(); } catch { /* vacío */ }
  const eventId = String(b?.eventId ?? "");
  const { data: ev } = await admin.from("events").select("id, owner_id").eq("id", eventId).maybeSingle();
  const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", u.user.id).maybeSingle();
  if (!ev || (ev.owner_id !== u.user.id && !prof?.is_admin)) return json({ error: "No autorizado." }, 403);

  const { data: orders } = await admin.from("orders").select("reference")
    .eq("event_id", ev.id).eq("status", "paid").is("email_sent_at", null).limit(200);
  let sent = 0;
  for (const o of orders ?? []) if (await sendTicketsEmail(admin, o.reference)) sent++;
  return json({ pending: orders?.length ?? 0, sent });
});

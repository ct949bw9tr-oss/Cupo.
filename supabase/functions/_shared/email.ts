// Correo con las boletas: se manda UNA sola vez por orden pagada (orders.email_sent_at), con Brevo.
// Diseño: fondo negro, el flyer del evento arriba, datos en letra limpia y el QR grande en blanco.
// El QR es una imagen que sirve la función ticket-qr (?code=). Secreto: BREVO_API_KEY.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const SITE = (Deno.env.get("SITE_URL") || "https://cupo-beryl.vercel.app").replace(/\/+$/, "");
const SENDER = { name: "Cupo", email: Deno.env.get("MAIL_FROM") || "cuposupport@gmail.com" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const COP = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");
const tz = "America/Bogota";

export async function sendTicketsEmail(admin: SupabaseClient, reference: string): Promise<boolean> {
  const key = Deno.env.get("BREVO_API_KEY");
  if (!key) { console.error("email: falta BREVO_API_KEY"); return false; }

  // Reclama el envío (evita mandar dos veces si el webhook y el navegador llegan al tiempo)
  const { data: claimed } = await admin.from("orders").update({ email_sent_at: new Date().toISOString() })
    .eq("reference", reference).eq("status", "paid").is("email_sent_at", null)
    .select("id, token, reference, buyer_name, buyer_email, qty, total, event_id").maybeSingle();
  if (!claimed) return false;
  const o = claimed;

  try {
    const { data: e } = await admin.from("events").select("name, starts_at, venue, city, cover_url, slug").eq("id", o.event_id).single();
    const { data: tix } = await admin.from("tickets").select("code, type_name, holder_name")
      .eq("order_id", o.id).eq("holder_email", o.buyer_email);
    if (!e || !tix?.length) throw new Error("orden sin evento o sin boletas");

    const start = new Date(e.starts_at);
    const fecha = new Intl.DateTimeFormat("es-CO", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(start);
    const hora = new Intl.DateTimeFormat("es-CO", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(start);
    const lugar = [e.venue, e.city].filter(Boolean).join(" · ");
    const qrBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1/ticket-qr?code=`;
    const orderUrl = `${SITE}/?o=${o.id}&k=${o.token}`;

    const ticketBlocks = tix.map((t, i) => `
      <tr><td style="padding:0 0 18px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#111115;border:1px solid #2a1010;border-radius:20px">
          <tr><td style="padding:22px 22px 6px;font-family:Helvetica,Arial,sans-serif">
            <div style="font-size:11px;letter-spacing:4px;color:#ff3b3b;font-weight:bold">BOLETA ${tix.length > 1 ? `${i + 1} DE ${tix.length}` : ""}</div>
            <div style="font-size:22px;color:#f6f6f1;font-weight:bold;margin-top:6px">${esc(t.holder_name)}</div>
            <div style="font-size:14px;color:#9b9ba8;margin-top:2px">${esc(t.type_name)}</div>
          </td></tr>
          <tr><td align="center" style="padding:14px 22px 6px">
            <div style="background:#ffffff;border-radius:18px;padding:14px;display:inline-block;border:3px solid #ff3b3b">
              <img src="${qrBase}${encodeURIComponent(t.code)}" width="220" height="220" alt="QR ${esc(t.code)}" style="display:block;width:220px;height:220px">
            </div>
          </td></tr>
          <tr><td align="center" style="padding:10px 22px 22px;font-family:'Courier New',monospace;font-size:18px;letter-spacing:3px;color:#f6f6f1;font-weight:bold">${esc(t.code)}</td></tr>
        </table>
      </td></tr>`).join("");

    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#07070a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07070a"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
  <tr><td style="padding:0 4px 18px;font-family:Helvetica,Arial,sans-serif;font-size:26px;font-weight:900;color:#f6f6f1;letter-spacing:-1px">cupo<span style="color:#c8ff3d">.</span></td></tr>
  ${e.cover_url ? `<tr><td style="padding:0 0 18px"><img src="${esc(e.cover_url)}" width="480" alt="${esc(e.name)}" style="display:block;width:100%;max-width:480px;border-radius:20px"></td></tr>` : ""}
  <tr><td style="padding:0 4px 18px;font-family:Helvetica,Arial,sans-serif">
    <div style="font-size:13px;letter-spacing:4px;color:#ff3b3b;font-weight:bold">¡ESTÁS DENTRO!</div>
    <div style="font-size:28px;color:#f6f6f1;font-weight:bold;margin-top:6px;letter-spacing:1px">${esc(e.name).toUpperCase()}</div>
    <div style="font-size:15px;color:#d9d9d2;margin-top:10px;line-height:1.5">${esc(fecha.charAt(0).toUpperCase() + fecha.slice(1))} · ${esc(hora)}<br>${esc(lugar)}</div>
  </td></tr>
  ${ticketBlocks}
  <tr><td style="padding:4px 4px 18px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#9b9ba8;line-height:1.6">
    Muestra este QR en la entrada (con el brillo del celular alto). Cada QR sirve una sola vez.
    Si le pasas la boleta a alguien desde Cupo, el QR cambia y este deja de servir.
  </td></tr>
  <tr><td align="center" style="padding:0 0 22px">
    <a href="${orderUrl}" style="display:inline-block;background:#c8ff3d;color:#0c1200;font-family:Helvetica,Arial,sans-serif;font-weight:bold;font-size:15px;text-decoration:none;padding:14px 28px;border-radius:99px">Ver mi boleta en Cupo</a>
  </td></tr>
  <tr><td style="padding:0 4px;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#6c6c78;line-height:1.6;border-top:1px solid #1d1d24;padding-top:14px">
    Orden ${esc(o.reference)} · ${o.qty} boleta${o.qty === 1 ? "" : "s"} · Total ${COP(Number(o.total))}<br>
    Compraste a nombre de ${esc(o.buyer_name)} (${esc(o.buyer_email)}). Entra a Cupo con este correo para ver tus boletas cuando quieras.
  </td></tr>
</table></td></tr></table></body></html>`;

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: SENDER,
        to: [{ email: o.buyer_email, name: o.buyer_name }],
        subject: `Tu boleta para ${e.name} 🎟️`,
        htmlContent: html,
        textContent: `¡Estás dentro! ${e.name} · ${fecha} ${hora} · ${lugar}. Códigos: ${tix.map((t) => t.code).join(", ")}. Ver tu boleta: ${orderUrl}`,
      }),
    });
    if (!res.ok) throw new Error(`Brevo ${res.status} ${(await res.text()).slice(0, 300)}`);
    console.log("email enviado", reference, o.buyer_email);
    return true;
  } catch (err) {
    console.error("email falló", reference, String(err));
    await admin.from("orders").update({ email_sent_at: null }).eq("id", o.id);   // se puede reintentar
    return false;
  }
}

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

    // Franja del flyer borroso (web/covers/strip-<slug>@2x.png); si el evento no tiene, se usa la portada
    let strip = e.cover_url || "";
    try { const h = await fetch(`${SITE}/covers/strip-${e.slug}@2x.png`, { method: "HEAD" }); if (h.ok) strip = `${SITE}/covers/strip-${e.slug}@2x.png`; } catch { /* portada */ }
    const fechaCorta = new Intl.DateTimeFormat("es-CO", { timeZone: tz, day: "numeric", month: "long" }).format(start);
    const F = "font-family:-apple-system,Helvetica,Arial,sans-serif";
    const label = (t: string, right = false) => `<div style="${F};font-size:10px;letter-spacing:1.5px;color:#bebec4;font-weight:bold;${right ? "text-align:right" : ""}">${t}</div>`;

    // Cada boleta es un "pase" estilo Wallet: cupo. arriba, fecha a la derecha, franja del flyer, datos y QR
    const ticketBlocks = tix.map((t, i) => `
      <tr><td style="padding:0 0 22px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;border-radius:16px;overflow:hidden;border:1px solid #1d1d24">
          <tr>
            <td style="padding:14px 16px 12px;${F};font-size:24px;font-weight:900;color:#f6f6f1;letter-spacing:-1px">cupo<span style="color:#c8ff3d">.</span></td>
            <td align="right" style="padding:14px 16px 12px">${label(esc(hora.toUpperCase()), true)}<div style="${F};font-size:19px;color:#f6f6f1;text-align:right">${esc(fechaCorta)}</div></td>
          </tr>
          ${strip ? `<tr><td colspan="2" style="padding:0;line-height:0"><img src="${esc(strip)}" width="480" alt="" style="display:block;width:100%;max-width:480px;height:auto"></td></tr>` : ""}
          <tr><td colspan="2" style="padding:16px 18px 0">${label("EVENTO")}<div style="${F};font-size:20px;color:#f6f6f1;margin-top:3px">${esc(e.name)}</div></td></tr>
          <tr>
            <td style="padding:14px 18px 0;vertical-align:top">${label(tix.length > 1 ? `BOLETA ${i + 1} DE ${tix.length}` : "BOLETA")}<div style="${F};font-size:16px;color:#f6f6f1;margin-top:3px">${esc(t.type_name)}</div></td>
            <td align="right" style="padding:14px 18px 0;vertical-align:top">${label("A NOMBRE DE", true)}<div style="${F};font-size:16px;color:#f6f6f1;margin-top:3px;text-align:right">${esc(t.holder_name)}</div></td>
          </tr>
          <tr><td colspan="2" align="center" style="padding:26px 18px 8px">
            <div style="background:#ffffff;border-radius:8px;padding:10px;display:inline-block">
              <img src="${qrBase}${encodeURIComponent(t.code)}" width="200" height="200" alt="QR ${esc(t.code)}" style="display:block;width:200px;height:200px">
            </div>
          </td></tr>
          <tr><td colspan="2" align="center" style="padding:4px 18px 22px;${F};font-size:13px;letter-spacing:2px;color:#bebec4">${esc(t.code)}</td></tr>
        </table>
      </td></tr>`).join("");

    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#07070a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07070a"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px">
  <tr><td style="padding:0 4px 18px;font-family:Helvetica,Arial,sans-serif;font-size:26px;font-weight:900;color:#f6f6f1;letter-spacing:-1px">cupo<span style="color:#c8ff3d">.</span></td></tr>
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

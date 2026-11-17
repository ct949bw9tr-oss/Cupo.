// Boleta para Apple Wallet: GET /functions/v1/wallet-pass?code=CUP-XXXX-XXXX → archivo .pkpass.
// El código de la boleta es el mismo QR de entrada: quien lo tiene ya tiene la boleta, así que
// no pedimos sesión (Safari en iPhone abre el .pkpass con un enlace normal, sin encabezados).
// Si la boleta se transfiere, el código rota y el pase viejo deja de servir en la puerta.
// Se despliega con verify_jwt = false.
//
// Secretos: APPLE_PASS_TYPE_ID (pass.xxx), APPLE_TEAM_ID, APPLE_PASS_CERT (PEM), APPLE_PASS_KEY (PEM).
// Opcional: APPLE_WWDR_PEM (si no, se baja el intermedio G4 de Apple).
import forge from "npm:node-forge@1.3.1";
import { zipSync } from "npm:fflate@0.8.2";
import { adminClient } from "../_shared/mp.ts";
import { buildPkpass, derToPem } from "../_shared/pkpass.ts";
import { PASS_IMAGES } from "../_shared/pass-images.ts";

const CODE = /^CUP-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const WWDR_URL = "https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer";
const SITE = "https://cupo-beryl.vercel.app";
let wwdrCache = "";

const text = (msg: string, status: number) =>
  new Response(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

async function wwdrPem(): Promise<string> {
  const env = Deno.env.get("APPLE_WWDR_PEM");
  if (env) return env;
  if (!wwdrCache) {
    const r = await fetch(WWDR_URL);
    if (!r.ok) throw new Error("No se pudo bajar el certificado WWDR de Apple");
    wwdrCache = derToPem(new Uint8Array(await r.arrayBuffer()), forge);
  }
  return wwdrCache;
}

const pem = (v: string | undefined) => (v ?? "").replace(/\\n/g, "\n").trim();
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const tz = "America/Bogota";
const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat("es-CO", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
const fmtTime = (d: Date) =>
  new Intl.DateTimeFormat("es-CO", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);

Deno.serve(async (req) => {
  if (req.method !== "GET") return text("Método no permitido", 405);
  const code = (new URL(req.url).searchParams.get("code") ?? "").trim().toUpperCase();
  if (!CODE.test(code)) return text("Código de boleta inválido.", 400);

  const passTypeId = Deno.env.get("APPLE_PASS_TYPE_ID"), teamId = Deno.env.get("APPLE_TEAM_ID");
  const certPem = pem(Deno.env.get("APPLE_PASS_CERT")), keyPem = pem(Deno.env.get("APPLE_PASS_KEY"));
  if (!passTypeId || !teamId || !certPem || !keyPem) return text("Apple Wallet todavía no está activado.", 503);

  const admin = adminClient();
  const { data: t } = await admin.from("tickets")
    .select("id, code, type_name, holder_name, checked_in_at, event:events(name, slug, starts_at, venue, city)")
    .eq("code", code).maybeSingle();
  if (!t || !t.event) return text("Boleta no encontrada.", 404);
  // deno-lint-ignore no-explicit-any
  const e: any = Array.isArray(t.event) ? t.event[0] : t.event;
  const start = new Date(e.starts_at);
  const place = [e.venue, e.city].filter(Boolean).join(", ");

  const pass = {
    formatVersion: 1,
    passTypeIdentifier: passTypeId,
    teamIdentifier: teamId,
    serialNumber: `${t.id}-${t.code}`,
    organizationName: "Cupo",
    description: `Boleta · ${e.name}`,
    logoText: "",
    backgroundColor: "rgb(7, 7, 10)",
    foregroundColor: "rgb(255, 255, 255)",
    labelColor: "rgb(200, 255, 61)",
    relevantDate: start.toISOString(),
    expirationDate: new Date(start.getTime() + 24 * 36e5).toISOString(),
    voided: !!t.checked_in_at,
    barcodes: [{ format: "PKBarcodeFormatQR", message: t.code, messageEncoding: "iso-8859-1", altText: t.code }],
    eventTicket: {
      primaryFields: [{ key: "event", label: "EVENTO", value: e.name }],
      secondaryFields: [
        { key: "date", label: "FECHA", value: fmtDate(start) },
        { key: "time", label: "HORA", value: fmtTime(start), textAlignment: "PKTextAlignmentRight" },
      ],
      auxiliaryFields: [
        { key: "type", label: "BOLETA", value: t.type_name },
        { key: "holder", label: "A NOMBRE DE", value: t.holder_name, textAlignment: "PKTextAlignmentRight" },
      ],
      backFields: [
        { key: "place", label: "Lugar", value: place || "Por confirmar" },
        { key: "code", label: "Código", value: t.code },
        { key: "info", label: "Importante",
          value: "Muestra este QR en la entrada. Si transfieres la boleta desde Cupo, este pase deja de servir." },
        { key: "link", label: "Ver el evento", value: `${SITE}/#/e/${e.slug}` },
      ],
    },
  };

  const files: Record<string, Uint8Array> = { "pass.json": new TextEncoder().encode(JSON.stringify(pass)) };
  for (const [name, data] of Object.entries(PASS_IMAGES)) files[name] = b64(data);

  try {
    const zip = buildPkpass(files, { certPem, keyPem, wwdrPem: await wwdrPem() }, forge, zipSync);
    return new Response(zip, {
      headers: {
        "Content-Type": "application/vnd.apple.pkpass",
        "Content-Disposition": `attachment; filename="cupo-${t.code}.pkpass"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("wallet-pass", err);
    return text("No se pudo crear el pase. Intenta de nuevo.", 500);
  }
});

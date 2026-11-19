// Imagen PNG del QR de una boleta, para el correo: GET /functions/v1/ticket-qr?code=CUP-XXXX-XXXX
// El código ya es el QR de entrada (quien lo tiene ya tiene la boleta), así que no pide sesión.
// verify_jwt = false. Si la boleta se transfiere, el código cambia y esta URL deja de servir en la puerta.
import QRCode from "npm:qrcode@1.5.4";

const CODE = /^CUP-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

Deno.serve(async (req) => {
  const code = (new URL(req.url).searchParams.get("code") ?? "").trim().toUpperCase();
  if (!CODE.test(code)) return new Response("Código inválido", { status: 400 });
  const png: Uint8Array = await QRCode.toBuffer(code, { width: 480, margin: 1, errorCorrectionLevel: "M" });
  return new Response(png, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" },
  });
});

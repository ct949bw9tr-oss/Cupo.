// Copia este archivo como config.js y pon tus datos reales.
// La llave "anon" de Supabase es pública (va en el navegador). NUNCA pongas aquí
// la llave service_role ni la llave privada / secreto de integridad de Wompi.
window.CUPO_CONFIG = {
  APP_NAME: "Cupo",
  CITY: "Barranquilla",
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "TU_LLAVE_ANON",
  DEMO: false,
  OTP_LENGTH: 6, // dígitos del código que llega al correo (igual que en Supabase → Auth → Email)
  BOLD_ON: false, // true = al pagar se puede escoger Bold o Mercado Pago (prueba antes con ?bold=1 en el link)
  EPAYCO_ON: false,  // true para mostrar "Pagar con Davipay" (cuando la cuenta de Davipay esté aprobada)
  EPAYCO_TEST: false, // true = modo pruebas de ePayco (los pagos de prueba NO emiten boletas)
  EPAYCO_PUBLIC_KEY: "",
  APPLE_WALLET: false, // true cuando los certificados de Apple estén en Supabase (función wallet-pass)
  MP_BRICK: false, // true = formulario de pago dentro de Cupo; false = página de Mercado Pago (más confiable)
  MP_PUBLIC_KEY: "", // Public Key de producción de Mercado Pago (cuenta de Cupo). Vacío = pagar en la página de Mercado Pago
};

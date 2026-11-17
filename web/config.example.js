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
  APPLE_WALLET: false, // true cuando los certificados de Apple estén en Supabase (función wallet-pass)
};

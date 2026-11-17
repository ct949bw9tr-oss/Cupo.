// Datos públicos de Supabase (la llave anon puede ir en el navegador).
window.CUPO_CONFIG = {
  APP_NAME: "Cupo",
  CITY: "Barranquilla",
  SUPABASE_URL: "https://xlkyrtjtwyzpmjsdokgn.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhsa3lydGp0d3l6cG1qc2Rva2duIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0MzAyMTEsImV4cCI6MjExMDAwNjIxMX0.IC9cZppXosPwzBB6x3pJHDbS9eWVqsDZR0aDJ3LPM-E",
  DEMO: false,
  OTP_LENGTH: 6, // dígitos del código que llega al correo (igual que en Supabase → Auth → Email)
  APPLE_WALLET: false, // true cuando los certificados de Apple estén en Supabase (función wallet-pass)
  MP_PUBLIC_KEY: "APP_USR-e3a6a992-2633-41ba-8ccd-fe155d074589", // Public Key de producción de Mercado Pago (cuenta de Cupo). Vacío = pagar en la página de Mercado Pago
};

-- Boleta por correo (19 nov 2026): cada orden pagada se manda una sola vez al correo del comprador.
alter table public.orders add column if not exists email_sent_at timestamptz;

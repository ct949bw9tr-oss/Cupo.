# Cómo abrir Cupo en Claude Code

## 1. Instala Claude Code (una sola vez)
En la Terminal de tu computador:

    curl -fsSL https://claude.ai/install.sh | bash

(o con Node: `npm install -g @anthropic-ai/claude-code`). La primera vez te pide entrar con tu cuenta de Claude.

## 2. Abre el proyecto
Descomprime `cupo.zip` donde quieras (por ejemplo en Documentos) y luego:

    cd ~/Documents/cupo
    git init && git add . && git commit -m "Cupo: punto de partida"
    claude

Claude Code lee `CLAUDE.md` solo, así que ya sabe qué es Cupo, qué falta y las reglas.

## 3. Pégale este primer mensaje

> Lee CLAUDE.md. El backend de Supabase ya está creado y desplegado. Ayúdame a terminar los pasos
> pendientes uno por uno, a publicar web/ en Vercel y a probar una compra completa en el sandbox
> de Wompi. Si algo falla, revisa los logs de las Edge Functions antes de cambiar código.

## Qué hay en la carpeta
- `CLAUDE.md` — el contexto y las reglas del proyecto para Claude Code.
- `web/` — la app real, ya conectada a tu Supabase.
- `demo/` — la vista de prueba que ya tenías, con todo simulado. Sirve de referencia.
- `supabase/` — la base de datos (migración SQL) y las 3 funciones de pago, ya desplegadas en tu proyecto.

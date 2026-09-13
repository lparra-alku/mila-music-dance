# Worker de IA — Mila Music Dance

Intermediario gratuito en Cloudflare que guarda la llave de ElevenLabs y limita el uso.

## Reglas que aplica
- 2 canciones con IA por iPad por día (`DAILY_PER_DEVICE` en wrangler.toml).
- Tope global de 9,000 créditos al mes (`MONTHLY_CREDITS`). Ojo: la API de música NO funciona en el plan gratis de ElevenLabs; requiere plan Starter (30,000 créditos al mes). Sube el tope a 27000 si quieres usar casi todo.
- Canciones de 30 segundos (450 créditos cada una), máximo 60.
- PIN de adulto para saltarse el límite diario (`PARENT_PIN`).
- Filtro de palabras antes de enviar la letra.
- Solo cobra monedas si ElevenLabs respondió bien.

## Despliegue (una sola vez, ~10 minutos)
Todo desde la carpeta `worker/`:

1. Iniciar sesión en Cloudflare (abre el navegador):
```bash
npx wrangler login
```
2. Crear el almacén de contadores y pegar el `id` que devuelve en `wrangler.toml`:
```bash
npx wrangler kv namespace create COINS
```
3. Guardar la llave de ElevenLabs (la pide en la terminal; se obtiene en elevenlabs.io → Profile → API Keys):
```bash
npx wrangler secret put ELEVENLABS_API_KEY
```
4. Guardar el PIN de adulto:
```bash
npx wrangler secret put PARENT_PIN
```
5. Publicar. Al final imprime la URL, tipo `https://mila-music.<usuario>.workers.dev`:
```bash
npx wrangler deploy
```
6. Pegar esa URL en `index.html`, en la constante `WORKER_URL`. Al abrir la app aparece la tarjeta de monedas y el botón "Crear con IA".

## Probar en local sin publicar
```bash
npx wrangler dev --local --var ELEVENLABS_API_KEY:TU_LLAVE --var PARENT_PIN:1234
```
y poner `WORKER_URL = 'http://localhost:8787'` en `index.html`.

## Cambiar límites
Editar `[vars]` en `wrangler.toml` y volver a ejecutar `npx wrangler deploy`.

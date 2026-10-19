# Worker de IA — Mila Music Dance

Intermediario gratuito en Cloudflare que guarda la llave de ElevenLabs y limita el uso.

## Protecciones (nadie más puede gastar tus créditos)
1. **Origen permitido.** Solo acepta peticiones que vengan de `lparra-alku.github.io`. Un `curl` desde una terminal recibe 403.
2. **Turnstile de Cloudflare.** Cada canción exige un token nuevo que prueba que quien pide es un navegador real con la app abierta. En modo gestionado: normalmente invisible, y si hay duda muestra una casilla en vez de dejar al niño atorado.
3. **Tope global diario.** Máximo 40 canciones al día entre todos los usuarios (`DAILY_GLOBAL_SONGS`). Es el seguro contra sorpresas: pase lo que pase, el gasto del día está acotado.
4. **Límite por conexión.** 6 canciones por hora y 12 al día desde una misma IP (`IP_HOUR`, `IP_DAY`). Frena a quien borre los datos del navegador para reiniciar sus monedas.

Si algo falla y hay que desactivar la verificación de emergencia: pon `REQUIRE_TURNSTILE = "0"` en `wrangler.toml` y vuelve a publicar.

## Monedero
Cada usuario tiene dos bolsillos. Las **gratis del día** (`FREE_DAILY`, hoy 5) se gastan primero. Las **compradas** son permanentes y solo suben con una compra confirmada.
- `GET /wallet?uid=...` devuelve `{free, freeMax, paid, total}`.
- `POST /wallet/grant` abona monedas compradas. Exige la cabecera `X-Admin-Key` y un `ref` único por compra: si la misma compra llega dos veces, se abona una sola vez. La llave vive en `~/.config/musicdance/admin_key`, nunca en el repositorio.
- Los topes globales y por IP aplican solo a las monedas gratis. Las compradas ya están pagadas.
- Un candado de 60 segundos por usuario evita que dos toques seguidos gasten de más.

Para abonar monedas a mano, por ejemplo a un usuario de prueba:
```bash
curl -s -X POST https://mila-music.mp-music.workers.dev/wallet/grant -H 'Content-Type: application/json' -H "X-Admin-Key: $(cat ~/.config/musicdance/admin_key)" -d '{"uid":"ID_DEL_USUARIO","coins":20,"ref":"manual-001","reason":"regalo"}'
```

## Reglas que aplica
- 5 canciones con IA por iPad por día (`DAILY_PER_DEVICE`) (`DAILY_PER_DEVICE` en wrangler.toml).
- El Worker consulta el saldo REAL de ElevenLabs antes de cada canción y deja una reserva de 1,000 créditos (`RESERVE_CREDITS`). El contador propio (`MONTHLY_CREDITS`) solo se usa de respaldo.
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

## Ver el estado
```
https://mila-music.mp-music.workers.dev/status
```
Muestra el saldo real de ElevenLabs, las canciones del día contra el tope global y el último error.

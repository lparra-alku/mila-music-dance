# Mila Music Dance — MVP v0

Juego web de un solo archivo (`index.html`). Sin cuenta de desarrollador, sin servidores de pago, sin APIs de pago.

## Qué hace hoy
1. **Letra → canción**: escribes versos, eliges estilo (pop, reggaetón, rock, cumbia, dulce) y "voz" (sonido del sintetizador). La app compone melodía, bajo, acordes y batería con Web Audio. La letra se muestra tipo karaoke.
2. **Coreografía**: 8 pasos con emoji. Tocas un paso y luego las casillas (una por compás). Botón "Sorpresa" para aleatorio. Bailarín animado al ritmo.
3. **Compartir**: graba un video MP4 vertical estilo Just Dance con audio, y exporta la canción en MP3. Abre la hoja de compartir de iOS (WhatsApp, Instagram, guardar en Fotos/Archivos).

## Cómo probarlo en el iPad (gratis)
Opción A — GitHub Pages (recomendada):
1. Crear un repositorio público en GitHub y subir `index.html`.
2. Settings → Pages → Branch `main` → guardar. Queda en `https://<usuario>.github.io/<repo>/`.
3. En el iPad, abrir esa URL en Safari → botón Compartir → "Añadir a pantalla de inicio". Se abre como app a pantalla completa.

Opción B — misma red WiFi:
```bash
cd "/Users/luisparra/Desktop/Aplicación Mila" && python3 -m http.server 8765
```
En el iPad abrir `http://<IP-del-Mac>:8765/`.

Nota: la exportación a MP3 usa la librería gratuita lamejs desde un CDN, así que necesita internet la primera vez.

## Limitaciones de esta versión
- La "voz" no canta la letra: es un sintetizador que toca la melodía. Cantar de verdad requiere una API de IA (siguiente fase) o que la niña grabe su voz encima (fácil de agregar con el micrófono).
- El bailarín es un muñeco de palitos. Se puede cambiar por dibujos de Mila.
- Todo vive en el navegador; no se guardan canciones todavía (siguiente: localStorage).

## Próximos pasos sugeridos
1. Grabar la voz de la niña sobre la pista con el micrófono (karaoke).
2. Guardar canciones y coreografías en el iPad.
3. Reemplazar el bailarín por el personaje dibujado por Mila.
4. Pasos propios grabados con la cámara (más adelante).

# Music Dance — app nativa (iOS y Android)

Envoltorio con Capacitor 7 de la misma app web (`../index.html`). Una sola fuente de código:
lo que cambias en la web llega a las apps con `npm run sync`.

- **Identificador:** `com.milaparra.musicdance` (no se puede cambiar después de publicar)
- **iOS:** proyecto en `ios/App`, dependencias con Swift Package Manager (no necesita CocoaPods)
- **Android:** proyecto en `android/`
- **Iconos y pantalla de inicio:** se generan desde `resources/icon.png` y `resources/splash.png`

## Requisitos (una sola vez)
- **iOS:** Xcode desde la App Store. Para publicar: cuenta Apple Developer (99 USD/año).
- **Android:** Android Studio (trae Java y el SDK). Para publicar: cuenta Google Play Console (25 USD, pago único).

Tras instalar Xcode, activa sus herramientas:
```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

## Uso diario
```bash
cd "/Users/luisparra/Desktop/Aplicación Mila/app" && npm install
```
```bash
cd "/Users/luisparra/Desktop/Aplicación Mila/app" && npm run ios
```
```bash
cd "/Users/luisparra/Desktop/Aplicación Mila/app" && npm run android
```
Cada comando copia la web actual, sincroniza y abre el proyecto en Xcode o Android Studio. Ahí se elige el simulador o el dispositivo y se pulsa Run.

## Si cambias el icono
```bash
cd "/Users/luisparra/Desktop/Aplicación Mila/app" && npx @capacitor/assets generate --iconBackgroundColor '#1a0b3d' --splashBackgroundColor '#1a0b3d'
```

## Notas
- La app nativa llama al mismo Worker; su origen `https://localhost` ya está autorizado.
- Pendiente antes de publicar: compras dentro de la app, DeviceCheck/Play Integrity y política de privacidad.

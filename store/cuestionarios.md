# Respuestas para los cuestionarios de las tiendas · Music Dance

Basadas en lo que la app y el Worker hacen hoy, revisado en el código. Si cambia algo de lo que se recoge, hay que actualizar estas respuestas y el aviso de privacidad.

## Lo que la app maneja (resumen técnico)

| Dato | Dónde vive | Caducidad |
|---|---|---|
| Identificador aleatorio del dispositivo | Dispositivo y Worker (monedero) | Sin caducidad mientras haya saldo |
| Letra de la canción | Se envía a ElevenLabs; el Worker solo la guarda si falla | 7 días |
| Canciones, coreografías, biblioteca | Solo en el dispositivo | Hasta que se borren |
| IP | Contadores anti abuso en el Worker | 2 a 48 horas |
| Código familiar | Worker, solo como huella SHA-256 | Hasta borrar la cuenta |
| Compras (cuando existan) | Worker: monto de monedas e id de la compra | Mientras exista la cuenta |

No hay anuncios, analítica de terceros, rastreo, ubicación, cámara, micrófono ni contactos.

## Apple · Privacidad de la app (App Privacy)

**¿Recopila datos?** Sí.

| Tipo de dato de Apple | Uso | ¿Vinculado al usuario? | ¿Rastreo? |
|---|---|---|---|
| Identificadores › ID del dispositivo | Funcionalidad de la app | Sí | No |
| Contenido del usuario › Otro contenido del usuario (la letra) | Funcionalidad de la app | No | No |
| Compras › Historial de compras | Funcionalidad de la app | Sí | No |

**Rastreo (App Tracking Transparency):** No. La app no necesita mostrar el aviso de rastreo.

## Apple · Categoría Niños

- Rango de edad: **6 a 8 años**.
- Sin anuncios de terceros ni analítica de terceros: cumple.
- Puerta parental antes de compras, enlaces externos y compartir: cumple.
- Opción de borrar la cuenta dentro de la app: cumple.

## Google Play · Seguridad de los datos (Data safety)

**¿La app recopila o comparte datos del usuario?** Sí, recopila. No comparte: los proveedores que procesan datos en nuestro nombre no cuentan como "compartir" para Google.

| Categoría de Google | ¿Recopilado? | ¿Opcional? | Propósito |
|---|---|---|---|
| Identificadores del dispositivo u otros | Sí | No | Funcionalidad de la app, prevención de fraude |
| Actividad en la app › Otro contenido generado por el usuario | Sí | Sí, solo al usar la IA | Funcionalidad de la app |
| Información financiera › Historial de compras | Sí, cuando haya compras | Sí | Funcionalidad de la app |

- **¿Los datos se cifran en tránsito?** Sí.
- **¿El usuario puede pedir que se borren?** Sí: borrar cuenta dentro de la app y por correo.

## Google Play · Público objetivo y programa de Familias

- Grupos de edad: **6 a 8** y **9 a 12**.
- La app atrae a niños: sí, y se incluye en el programa de Familias.
- SDKs: solo Capacitor y sus plugins oficiales. Al agregar RevenueCat, revisar que esté en la lista de SDKs autorizados para Familias.

## Clasificación por edad (Apple y cuestionario IARC de Google)

| Pregunta | Respuesta |
|---|---|
| Violencia, sangre, terror | No |
| Lenguaje soez u obscenidades | No; hay filtro de palabras |
| Temas sexuales o desnudos | No |
| Drogas, alcohol, tabaco | No |
| Apuestas o simulación de apuestas | No |
| Navegador web sin restricciones | No |
| Interacción entre usuarios, chat o contenido compartido entre usuarios | No |
| Comparte la ubicación | No |
| Compras dentro de la app | Sí, protegidas con puerta parental |
| Contenido generado con inteligencia artificial | Sí: canciones generadas a partir de la letra del usuario, con filtro de palabras y estilos limitados a contenido infantil |

Resultado esperado: **4+** en Apple y **Para todos / E** en Google.

## Pendientes que tienes que hacer tú

- **Desactivar el uso de datos para entrenamiento en ElevenLabs.** En su panel, sección de uso de datos. Las letras las escriben niños, así que no deben usarse para entrenar modelos. Mientras no se haga, el aviso de privacidad no debe afirmar lo contrario.
- **Completar los datos del responsable** en `store/privacidad.html`: nombre legal, domicilio y correo de contacto.
- **Confirmación por escrito de ElevenLabs** de que puedes vender canciones generadas con su servicio.

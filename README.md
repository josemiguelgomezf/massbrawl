# Mass Brawl

## Configurar el multijugador online con Firebase

El modo online usa Firebase Authentication anónimo y Firebase Realtime Database. No necesita una clave privada ni un servidor propio. La configuración web de Firebase que usa el cliente identifica el proyecto, pero no sustituye a las reglas de la base de datos.

1. En [Firebase Console](https://console.firebase.google.com/), crea un proyecto y registra una aplicación web para obtener su configuración.
2. En **Authentication → Sign-in method**, activa **Anonymous**.
3. En **Realtime Database**, crea una base de datos y selecciona la región. Copia la URL que muestra Firebase.
4. En Firebase Console, abre **Realtime Database → Rules** y publica el contenido de [`firebase-database.rules.json`](./firebase-database.rules.json). Si ya habías publicado reglas, vuelve a publicarlas para habilitar presencia, reconexión y resultados por abandono.
5. Copia `apiKey`, `authDomain`, `databaseURL`, `projectId` y `appId` de la configuración de la aplicación web en [`firebase-config.js`](./firebase-config.js), sustituyendo los textos `PEGA_AQUI_...`.
6. Sirve la carpeta desde `localhost` durante el desarrollo o publícala en un sitio HTTPS. No abras `index.html` directamente como archivo (`file://`): el SDK modular de Firebase se carga desde su CDN.
7. Si publicas la web, añade su dominio en **Authentication → Settings → Authorized domains**. Para Android, ejecuta `npm run build:web` para copiar los archivos al `www` que espera Capacitor y luego `npx cap sync android`; después prueba el inicio anónimo desde la aplicación instalada.

Para probarlo, abre el juego en dos sesiones del navegador o en dispositivos distintos. En uno crea una sala y comparte el código; en el otro, introdúcelo en “Unirse con código”. También puedes usar “Búsqueda aleatoria” desde dos clientes. La autenticación anónima se mantiene por sesión de navegador para que dos pestañas no se identifiquen accidentalmente como el mismo jugador.

Las reglas requieren un usuario autenticado y limitan la escritura de salas a sus participantes (con una excepción para que un segundo participante se una a una sala esperando). La app detecta desconexiones mediante Realtime Database: espera hasta 60 segundos a que el rival vuelva; salir voluntariamente durante una partida cuenta como abandono. El tablero se sincroniza durante los movimientos. No es un sistema antitrampas con simulación autoritativa en servidor; para partidas competitivas o recompensas con valor, valida las jugadas y los resultados mediante Cloud Functions.

Las monedas, los artículos de la tienda, los logros y las skins compradas/equipadas se guardan localmente en cada dispositivo; no se transfieren al jugar online ni al cambiar de dispositivo.

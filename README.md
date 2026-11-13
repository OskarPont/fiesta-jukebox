# fiesta. — jukebox colaborativo para Spotify

Los invitados escanean un QR, ponen el PIN y su nombre, y controlan la música de tu cuenta de Spotify Premium: buscar, añadir a la cola, votar, dar like a lo que suena, pausar y saltar. Sin app ni cuenta para los invitados.

- **Invitados:** `/fiesta/` · **Panel del anfitrión:** `/fiesta/admin/` · **Pantalla (TV/proyector):** `/fiesta/pantalla/`
- Node 26 (LTS) + Fastify, frontend sin build, tiempo real con SSE, estado en JSON (`data/`). Sin base de datos.
- Cola con votos, cupos y tiempos de espera por invitado, saltar por votación, «Clásicos de fiesta» (playlist automática con lo que más gustó), resumen de la noche y guardado como playlist.

## Requisitos

- Una cuenta de **Spotify Premium** (Spotify no deja controlar la reproducción sin Premium).
- Un servidor con **Docker** y un dominio con **HTTPS** delante (Caddy, Nginx, Traefik…).
- Para probar en local basta con Node 26 (la LTS actual): hay un modo con Spotify simulado.

## Probar en local (sin Spotify)

```bash
npm ci
SPOTIFY_MOCK=1 ADMIN_KEY=una-clave-local COOKIE_SECRET=un-secreto-local-de-32-caracteres npm start
```

Abre `http://127.0.0.1:3000/fiesta/admin/`, entra con la clave, pulsa «Conectar Spotify» (en modo simulado conecta al momento) y empieza una fiesta. En PowerShell, define las variables con `$env:SPOTIFY_MOCK='1'` y las demás de la misma forma antes de `npm start`.

## Instalar en tu servidor

1. **Descarga y configura**

   ```bash
   git clone https://github.com/OskarPont/fiesta-jukebox.git
   cd fiesta-jukebox
   cp .env.example .env
   ```

   Rellena `.env`: genera `ADMIN_KEY` y `COOKIE_SECRET` con `openssl rand -base64 32` (dos valores distintos) y pon tu `PUBLIC_URL`, por ejemplo `https://tu-dominio.com/fiesta`. El servidor no arranca si falta algo o si las claves son demasiado cortas.

2. **Arranca**

   ```bash
   docker compose up -d --build
   ```

   El contenedor solo escucha en `127.0.0.1:3000`; no queda expuesto a internet.

3. **Pon HTTPS delante.** Ejemplo con Caddy (consigue el certificado solo):

   ```
   tu-dominio.com {
       reverse_proxy /fiesta* 127.0.0.1:3000
   }
   ```

   Con Nginx, recuerda desactivar el buffer para que el tiempo real funcione (`proxy_buffering off;`) y pasar `X-Forwarded-For`. Si tu proxy no está en la misma máquina ni en una red privada, pon su IP en `TRUST_PROXY`.

   Si usas una red de Docker propia (por ejemplo, la de Nginx Proxy Manager), crea un `docker-compose.override.yml` (está en `.gitignore`):

   ```yaml
   services:
     fiesta:
       ports: !reset []
       networks: [proxy]
   networks:
     proxy: { external: true, name: nginx-proxy-manager_default }
   ```

4. **Conecta Spotify.**
   - En <https://developer.spotify.com/dashboard> crea una app con tu cuenta Premium.
   - Añade como *Redirect URI* exactamente `<PUBLIC_URL>/api/spotify/callback`.
   - En el panel de fiesta (`/fiesta/admin/`) pega el *Client ID* y el *Client Secret* y pulsa «Conectar Spotify».
   - Las credenciales y los tokens se guardan en el volumen de datos (con permisos `600`), nunca en el repositorio.

5. Abre Spotify en el altavoz o el ordenador de la fiesta, elígelo como dispositivo en el panel y pulsa «Empezar fiesta». Enseña el QR de la pantalla a los invitados.

## Seguridad

- El panel se protege con `ADMIN_KEY` (con límite de intentos) y una cookie firmada `HttpOnly` de 30 días. Para cerrar todas las sesiones de admin, cambia `COOKIE_SECRET`.
- Los invitados entran con un PIN de 4 cifras que cambia en cada fiesta. Hay límite de intentos por IP y un bloqueo global si se acumulan fallos; si sospechas algo, genera un PIN nuevo desde el panel.
- Banear a alguien invalida su sesión, pero con el PIN podría volver a entrar: tras un baneo, cambia el PIN.
- Peticiones con cambios solo con JSON y desde tu propio origen, CSP estricta y sin HTML generado con datos de usuarios.
- El contenedor corre sin root, con el sistema de archivos de solo lectura (salvo `data/`) y sin capacidades extra.
- Haz copia de seguridad de los datos (fiestas, clásicos y acceso a Spotify), que viven en el volumen `fiesta-data`: `docker compose cp fiesta:/app/data ./copia-fiesta` (guárdala en un sitio privado).

Para avisar de un fallo de seguridad, mira [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test                         # unitarios (sin red)
npm i --no-save playwright && npx playwright install chromium
node test/e2e.mjs                # e2e con navegador y Spotify simulado
node test/e2e-likes.mjs
```

Los e2e usan el Chromium de Playwright; con `PW_CHANNEL=chrome` (o `msedge`) usan el navegador instalado, y con `PW_EXECUTABLE=/ruta/a/chromium`, el que indiques.

## Licencia

[MIT](LICENSE)

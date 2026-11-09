# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Invitados:** gente en una fiesta, con el móvil en la mano, de noche y a menudo con poca luz y ruido. Entran escaneando un QR y poniendo un PIN y su nombre, sin app ni cuenta. Su trabajo: buscar una canción y ponerla en la cola, votar las de los demás, dar like a la que suena y, si el anfitrión lo permite, pausar o saltar.
- **Anfitrión:** quien monta la fiesta y pone su cuenta de Spotify Premium. Usa el panel (portátil o móvil) para empezar y terminar la fiesta, elegir el dispositivo, fijar las reglas, reordenar la cola y expulsar o banear. También está de fiesta: no puede pasarse la noche pendiente del panel.
- **Pantalla:** una TV o proyector en la sala que muestra lo que suena, lo que viene, el QR con el PIN y, al final, el resumen de la noche. Se mira de lejos, sin interacción.

Escenas por igual: fiestas en casa con amigos (10–40 personas) y eventos o locales (bares, bodas) con más gente.

## Product Purpose

Que la música de la fiesta sea de todos sin que el anfitrión pierda el control. Éxito: cualquiera pone su canción en segundos, la cola se siente justa, y el anfitrión manda sin vigilar el móvil toda la noche.

## Positioning

Un jukebox colaborativo sobre el Spotify del propio anfitrión: los invitados no instalan nada ni tienen cuenta, la cola es propia (votos, cupos por persona, tiempos de espera, salto por votación) y solo se le pasa a Spotify una canción cada vez, así que el anfitrión conserva el control fino que la cola compartida de Spotify no da.

## Operating Context

- Invitados: navegador del móvil, a menudo iPhone, brillo bajo, con prisa y distraídos; la sesión dura toda la noche.
- Anfitrión: panel en portátil o móvil, consultas puntuales durante la fiesta; el resto del tiempo está con la gente.
- Pantalla: TV a varios metros, 1080p o mayor, siempre encendida (de ahí el ligero movimiento antiquemado del QR).
- Tiempo real por SSE: lo que hace un invitado lo ven los demás al momento.

## Capabilities and Constraints

- Requiere Spotify Premium; con un iPhone como altavoz, Apple no deja cambiar el volumen ni que los invitados pausen.
- Funciones: entrada con PIN de 4 cifras y QR; búsqueda en Spotify; cola con votos o por orden de llegada; cupo y tiempo de espera por invitado; likes a la que suena y a las de la cola; pausar y saltar (directo, por votos o solo anfitrión); expulsar y banear; historial; resumen de la noche; playlists de la fiesta; «Clásicos de fiesta» como relleno y playlist automática.
- Tres superficies: `/` (invitados), `/admin/` (anfitrión), `/pantalla/` (TV).
- Proyecto open source (MIT) y autoalojable: cada uno lo monta con su propio servidor y su Spotify.
- Sin build de frontend: HTML, CSS y JS sin dependencias; Node + Fastify en el servidor.

## Brand Commitments

- Idioma: español cercano, tratando de tú; textos cortos y coloquiales, nunca corporativos.
- El nombre «fiesta.» no es un compromiso fijo (puede cambiar).

## Evidence on Hand

- No hay testimonios, clientes, cifras de uso ni prensa: no inventarlos.
- Las carátulas y los nombres de las canciones vienen de Spotify en tiempo real; en modo simulado (`SPOTIFY_MOCK=1`) el catálogo es inventado.

## Product Principles

1. Entrar y poner una canción debe costar segundos, con el móvil en una mano.
2. La cola tiene que sentirse justa: nadie acapara, todos pueden empujar lo que les gusta.
3. El anfitrión manda, pero con reglas que funcionan solas.
4. Lo que suena es lo importante: la interfaz no compite con la música.

## Accessibility & Inclusion

- Uso de noche con poca luz: contraste suficiente para leer de un vistazo y objetivos táctiles grandes.
- La pantalla se lee a varios metros.

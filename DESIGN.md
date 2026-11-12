---
name: fiesta.
description: Jukebox colaborativo para fiestas, oscuro y neutro, donde la carátula que suena pone el color y el rosa solo marca lo social.
colors:
  night: "#101012"
  surface: "#18181b"
  surface-2: "#1f1f23"
  surface-3: "#2a2a2f"
  surface-4: "#3a3a40"
  surface-raised: "#1c1c20"
  ghost: "#55555e"
  pin-placeholder: "#6b6b75"
  text: "#f5f5f7"
  text-2: "#d4d4d8"
  muted: "#a1a1aa"
  faint: "#8b8b95"
  primary: "#f5f5f7"
  primary-ink: "#0c0c0e"
  accent-pink: "#ff4d85"
  accent-ink: "#1f0410"
  danger: "#ff6b6b"
  danger-ink: "#ffc2c2"
  warn: "#ffb340"
  warn-ink: "#ffd699"
  ok: "#35d07f"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Segoe UI Variable Display, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "28px"
    fontWeight: 750
    lineHeight: 1.15
    letterSpacing: "-0.022em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Segoe UI Variable Display, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.018em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI Variable Text, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI Variable Text, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Segoe UI Variable Text, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.3
rounded:
  sm: "12px"
  md: "16px"
  lg: "22px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "22px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.pill}"
    height: "48px"
    padding: "0 22px"
  button-default:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    height: "48px"
    padding: "0 22px"
  button-default-hover:
    backgroundColor: "{colors.surface-3}"
  button-danger:
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
    height: "48px"
  input:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    height: "50px"
    padding: "0 16px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "20px"
  chip:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "5px 11px"
  vote:
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    height: "44px"
    width: "56px"
  vote-on:
    textColor: "{colors.accent-pink}"
---

# Design System: fiesta.

## Overview

**Creative North Star: "La sala a oscuras"**

fiesta. es una sala a media luz: la interfaz es una base casi negra y neutra, y todo el color lo pone lo que suena. La carátula actual tiñe el fondo (invitados) o inunda la pantalla (TV); el resto son superficies grises que no compiten con la música. El rosa es la única voz de marca y significa siempre lo social: likes, votos propios, «tu canción».

Es una herramienta de uso nocturno, con el móvil en una mano y brillo bajo, y un panel que el anfitrión consulta de pasada. Por eso la densidad es baja, los objetivos táctiles grandes (44-56 px) y el contraste alto. Las tres superficies comparten un mismo sistema de tokens (`shared.css`) y se distinguen por escala: móvil compacto, panel en tarjetas, TV en unidades `vh`.

**Key Characteristics:**
- Una sola base oscura (`night`), sin modo claro; `color-scheme: dark`.
- Capas tonales en vez de sombras para separar superficies; la sombra solo aparece en elementos flotantes.
- Acción principal en blanco, marca y likes en rosa, estados en verde, ámbar y rojo.
- Cápsulas (pill) para toda acción; contenedores redondeados de 16-22 px.
- Tipografía del sistema (SF / Segoe), titulares ajustados y pesos 650-800.
- Iconos de trazo de 2 px con puntas redondeadas, en SVG inline; nunca emojis.

## Colors

Neutros fríos casi sin croma, un rosa saturado y tres colores de estado. El color de gran superficie lo aporta la carátula.

### Primary
- **Blanco jukebox** (`#f5f5f7`): acción principal (Entrar, Añadir, Seguir) y texto. Sobre él, tinta casi negra (`#0c0c0e`).

### Secondary
- **Rosa fiesta** (`#ff4d85`): marca (el punto de «fiesta.»), likes, votos propios, ecualizador, cursor, selección de texto y foco de teclado. Tinta `#1f0410` sobre rosa lleno.

### Tertiary
- **Verde conectado** (`#35d07f`): Spotify conectado, reproductor listo, activo.
- **Ámbar aviso** (`#ffb340`; texto sobre aviso `#ffd699`): avisos recuperables (sin dispositivo, límite de Spotify, «sonó hace poco»).
- **Rojo error** (`#ff6b6b`; texto sobre alerta `#ffc2c2`): errores y acciones destructivas (Vaciar cola, Terminar fiesta, Banear).

### Neutral
- **Noche** (`#101012`): fondo de página.
- **Superficie** (`#18181b`), **Superficie 2** (`#1f1f23`), **Superficie 3** (`#2a2a2f`), **Superficie 4** (`#3a3a40`): escalones tonales para tarjetas, controles, hover y pulsado. **Superficie elevada** (`#1c1c20`): desplegable de resultados.
- **Texto** (`#f5f5f7`), **Texto 2** (`#d4d4d8`), **Apagado** (`#a1a1aa`), **Tenue** (`#8b8b95`): jerarquía de texto; Tenue es el mínimo para texto con significado (≥4.5:1 sobre `surface`).
- **Fantasma** (`#55555e`) y **Marcador PIN** (`#6b6b75`): solo iconos en reposo y el «0000» del PIN (texto grande, ≥3:1). Nunca texto con información.
- **Líneas** (`rgba(255,255,255,.07)` y `.13`): bordes de 1 px.
- **Tinte** (`--tint`, RGB variable): color medio de la carátula que suena; lo rellena `shared.js`.

### Named Rules
**The Rosa Means Social Rule.** El rosa aparece solo en lo que es de la gente (likes, votos, «tu canción», marca). Los estados de sistema usan verde, ámbar o rojo, y la acción principal es blanca.

**The Cover Sets The Mood Rule.** El único color de gran superficie es el tinte de la carátula, con transición lenta (1,2 s). Nada más se tiñe.

## Typography

**Display Font:** fuente del sistema, variante Display (SF Pro Display, Segoe UI Variable Display) con Roboto y Arial de reserva.
**Body Font:** fuente del sistema, variante Text.

**Character:** neutra y nativa en cada dispositivo, sin descargas; la personalidad viene del peso (650-800) y del tracking negativo en titulares.

### Hierarchy
- **Display TV** (800, `clamp(28px, 7.4vh, 100px)`, 1.04, -0.035em): título de la canción en la pantalla.
- **Display móvil** (750, `clamp(22px, 6.4vw, 28px)`, 1.15, -0.022em): título de lo que suena; el logo va en 800 con -0.035em.
- **Headline** (700, 19px, -0.018em): título de tarjeta del panel y valores grandes del resumen.
- **Title** (600, 16px, 1.3): título de resultado y de canción en cola.
- **Body** (400-500, 16-17px, 1.45): cuerpo; subtítulos de canción en 14-15px apagado.
- **Label** (600, 13px): etiquetas de campo, chips y rótulos como «¡Suena tu canción!»; siempre en minúscula normal.
- **PIN** (700, 36px, tracking 0.42em, tabulares): campo del PIN de entrada; en la TV 6.4vh.

### Named Rules
**The Whole Pixel Rule.** La escala de móvil y panel usa tamaños enteros: 13, 14, 15, 16, 17, 19, 24 px. Nada de medios píxeles.

**The Tabular Numbers Rule.** Tiempos, votos, cupos y PIN llevan `font-variant-numeric: tabular-nums` para no bailar.

## Layout

Móvil primero para invitados: una columna de 560 px máx. con 16 px de gutter y safe-areas. El panel es una rejilla de tarjetas (una columna en móvil, dos desde 980 px, máx. 1240 px) con cabecera fija compacta (≤140 px en móvil) y avisos abajo. La TV usa `vh`/`vw`: dos columnas 1.3fr/1fr con la carátula a la izquierda y cola + QR a la derecha; en vertical pasa a una columna. Ritmo de 6, 8, 10, 16 y 22 px; grupos apretados y separación generosa entre bloques. Objetivos táctiles de 44 px mínimo en invitados; en la cabecera móvil del panel los iconos son de 38 px por presupuesto de altura.

## Elevation & Depth

Híbrido, plano por defecto. Las superficies se separan con escalones tonales y un borde de 1 px; la sombra solo se concede a lo que flota o es protagonista.

### Shadow Vocabulary
- **Flotante** (`0 12px 32px -8px rgba(0,0,0,.6), 0 2px 6px rgba(0,0,0,.3)`): toasts, tarjeta de entrada, resumen.
- **Carátula** (`0 30px 60px -18px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.06)`): carátula que suena; en TV a escala `vh`.
- **Foco de campo** (`0 0 0 4px` rosa al 16 %): halo de los campos de texto.
- **Desenfoque:** `backdrop-filter` solo en cabecera fija del panel, toasts, insignia de pausa y bloque del QR, donde da legibilidad sobre contenido que pasa por debajo.

### Named Rules
**The Flat Until Floating Rule.** Una tarjeta en reposo no lleva sombra; la sombra indica que algo flota sobre el contenido.

## Shapes

Todo lo accionable es cápsula (999px): botones, chips, votos y toasts; los controles segmentados usan 8-11 px. Los contenedores son rectángulos redondeados: campos 12 px, tarjetas 16 px, entrada y resumen 22 px, carátulas 8-14 px. Las carátulas son siempre cuadradas. Los iconos son trazos de 2 px, de 18, 22 o 28 px; con relleno solo en estados activos (corazón, play).

## Components

### Buttons
- **Shape:** cápsula (999px), 48 px de alto; 56 px en `btn-lg`, 38 px en `btn-sm`.
- **Primary:** blanco con tinta oscura, peso 700; en hover pasa a `#fff` con un resplandor suave.
- **Default:** `surface-2` con borde de línea; hover `surface-3`; pulsado `scale(.97)`.
- **Danger:** rojo al 12 % con texto rojo. **Ghost:** transparente hasta el hover.
- **Disabled:** 40 % de opacidad y cursor `not-allowed`. **Foco:** anillo rosa de 2 px con 3 px de separación.

### Chips
- **Style:** cápsula `surface-2`, texto apagado de 13px; variantes accent, pink, warn, ok y danger con fondo del color al 13-14 %. Forman la línea de estado de la cabecera del panel.

### Cards / Containers
- **Corner Style:** 16 px; tarjetas del panel con 22 px de padding y cabecera título + subtítulo.
- **Background:** `surface` con borde de línea; sin sombra.
- **Nested:** nada de tarjeta dentro de tarjeta; solo bloques de datos en `surface-2` (resumen, historial).

### Inputs / Fields
- **Style:** 50 px, `surface-2`, borde de línea, radio 12 px, texto de 17px (evita el zoom de iOS).
- **Focus:** borde rosa al 70 % más halo de 4 px. **Placeholder:** `faint`; el del PIN, `pin-placeholder` en 36 px.
- **Selects, rangos e interruptores:** select con chevron SVG; rango con salida numérica asociada; interruptor de 50×30 px que se pone rosa al activarse.

### Navigation
- No hay navegación entre pantallas: cada superficie es una sola vista. El panel usa cabecera fija (logo, chips de estado, PIN, pantalla, salir) y secciones plegables (`details.fold`) con chevron.

### Cola (invitados y panel)
- **Fila:** carátula de 48-56 px, título, artista y «de [nombre]» en `faint`, o «Tu canción · n.º 2» en blanco; a la derecha el control de voto.
- **Voto:** cápsula de 44 px con flecha y recuento; gris en reposo, rosa con trazo grueso y pequeña animación al votar; al 55 % si está deshabilitado.
- **Panel:** fila arrastrable con asa enfocable, «Subir arriba» y quitar con deshacer en un toast.

### Ahora suena (signature)
- Carátula grande sobre el tinte de fondo, corazón de like flotando abajo a la derecha (cápsula de 46 px), título en display, barra de progreso de 4 px y la pareja Pausa (secundario) / Saltar n/m (blanco). En la TV es la misma composición a escala `vh`, con el QR y el PIN en un bloque de cristal que se desplaza muy despacio contra el quemado de pantalla.

### Toasts y avisos
- **Toast:** cápsula con desenfoque, abajo en invitados y panel, con acción opcional («Deshacer»); entra con translate y desenfoque en 0,36 s.
- **Aviso del panel:** bloque de 14 px con fondo del color al 10 % y borde al 28-35 %, agrupado y abajo para no tapar la cabecera.

## Do's and Don'ts

### Do:
- **Do** usar tokens de `shared.css` para todo color; si falta uno, añadirlo allí.
- **Do** mantener el rosa (`#ff4d85`) solo para lo social y la marca.
- **Do** dar 44 px de objetivo táctil mínimo en invitados y texto de 13px o más.
- **Do** dejar que la carátula ponga el color; todo lo demás es neutro.
- **Do** confirmar con deshacer en un toast en lugar de con diálogos modales.
- **Do** respetar `prefers-reduced-motion` (`shared.css` anula las animaciones).

### Don't:
- **Don't** usar rosa para estados de sistema ni verde o ámbar para lo social.
- **Don't** añadir bordes de color de 2 px en un solo lado de tarjetas o filas.
- **Don't** usar `ghost` ni `pin-placeholder` para texto con información.
- **Don't** poner sombras en tarjetas en reposo ni anidar tarjetas.
- **Don't** introducir medios píxeles en la escala tipográfica ni fuentes descargadas.
- **Don't** usar emojis o glifos como iconos; solo los SVG de trazo del sistema.
- **Don't** poner rótulos en mayúsculas con tracking sobre los títulos ni gradientes en texto.

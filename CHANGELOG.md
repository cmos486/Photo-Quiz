# Changelog — rama review-evento

## Modo automático de avance

- **Modo manual** (por defecto, sin cambios): el admin revela y pasa de foto.
- **Modo automático**: lo decide el SERVIDOR.
  - **Revelación**: cuando todos los jugadores conectados ahora mismo han votado (la misma noción de
    «conectados» que el contador de votos de la TV), revela solo.
  - **Avance**: tras un delay configurable pasa a la siguiente foto; tras la última, va al ranking final.
  - **Botones manuales**: siguen activos y se adelantan; el automático respeta lo que hizo el admin.
  - **Red de seguridad**: un tiempo máximo por foto (por defecto 60 s) revela aunque falten votos. Si no
    queda nadie conectado no se revela por votos; espera a esa red.
  - **Desconexiones**: si un jugador se desconecta y con eso ya han votado todos los demás, revela. Se
    espera 1,5 s para no contar una recarga de página como irse.
- **Un solo temporizador pendiente**, etiquetado con fase y foto (`reveal:<foto>` / `next:<foto>`), que
  vuelve a validar el estado al dispararse.
  - Revelar o pasar a mano, cambiar de modo, terminar, resetear o «Borrar todo» lo cancelan.
  - No hay doble avance ni temporizadores huérfanos.
  - Tras reiniciar el servidor, el modo automático se reanuda.
- **Ajustes** (`POST /api/admin/auto`, con auth de admin; se guardan en `session`):
  - Modo `manual` / `auto`.
  - Pausa tras revelar: 1-10 s, por defecto 3.
  - Tiempo máximo por foto: 10-600 s, por defecto 60.
- **Interruptor en caliente** en la pestaña Juego del admin.
- **Cuenta atrás**:
  - TV: «Siguiente foto en N s» / «Ranking final en N s».
  - Admin: además, el tiempo máximo restante.
  - `state_update` y `/api/state` incluyen `autoMode`, `autoDelay`, `autoTimeout` y `autoPending`.
- `test-auto-advance.js`: prueba de tiempos, bloqueos, carreras y temporizadores (solo en local).

## Identidad del jugador y fusión de duplicados

Contexto: en el evento, quien escaneaba el QR desde la app de la cámara jugaba en una vista de navegador
efímera; al cambiar de app la vista se cerraba y al volver (ya desde el navegador normal) aparecía como
un jugador nuevo con el mismo nombre.

- **Identidad persistente en el mismo navegador**: el `playerId` y el nombre se guardan en `localStorage`.
  Al recargar, o al volver tras cerrar la pestaña o bloquear el móvil, el cliente reconecta automáticamente
  al MISMO jugador, con su nombre, votos y puntos, sin duplicarlo. Los accesos a `localStorage` y
  `sessionStorage` van envueltos en try/catch: con el almacenamiento bloqueado el juego funciona igual,
  pero sin recordar al jugador. Un `playerId` desconocido, o borrado con "Borrar todo", crea un jugador
  nuevo normal. **Límite**: dos navegadores distintos (vista de cámara y navegador normal) no comparten
  `localStorage`; ese caso se resuelve fusionando.
- **Fusionar jugadores desde el panel admin** (`POST /api/admin/players/merge`, con auth de admin): se elige
  un jugador destino y uno o varios a fusionar, con confirmación previa. Los puntos se suman y los votos
  pasan al destino. Si dos jugadores votaron la misma foto, queda un solo voto: el del destino o, si el
  destino no la votó, el del primer fusionado. Los puntos de ese voto descartado no se suman. Los
  fusionados desaparecen de la lista y del ranking, y TV y móviles se actualizan en vivo.
- **Los móviles de los jugadores fusionados pasan a ser el destino**: al momento si están conectados, y si
  vuelven más tarde con su id antiguo, este redirige al destino (tabla `player_aliases`, que se vacía con
  "Borrar todo"). Así el duplicado no reaparece.
- `test-identity-merge.js`: prueba en Chrome real de ambos casos, solo contra un servidor local.

## Temáticas, música y rendimiento (`8f14c0d` … `8990325`)

### Funcional
- **Autores siempre al día en todos los clientes** (`39c330f`): `state_update` incluye la lista de autores
  y, al revelar, el nombre del autor. Una TV o móvil abiertos antes de crear los autores ya muestran
  botones de voto, barras y nombre revelado sin recargar. `/api/state` incluye `currentPhotoAuthorName`
  para recuperar el nombre al recargar durante la revelación. Nunca se envía el autor mientras se vota.
- **Límite de subida de 5 MB por foto** (`8f14c0d`): `MAX_UPLOAD_MB` (por defecto 5, configurable por env),
  413 con JSON `{error, code: FILE_TOO_LARGE, maxUploadMB}`, otros errores de subida 400 con código.
  `/api/state` expone `maxUploadMB` y el panel comprueba el tamaño antes de subir.
- **Temática visual** (`c001999`): `none` / `halloween` / `navidad` desde Ajustes del admin
  (`POST /api/admin/theme`), aplicada en TV y móviles en vivo. `none` = aspecto original.
- **Música de fondo solo en la TV** (`c001999`, `8990325`): MP3 en `audio/` (bind mount de solo lectura,
  no versionados): `ambient.mp3`, `halloween.mp3`, `navidad.mp3`, con `ambient.mp3` como fallback común.
  Reproductor nativo en bucle, arranca en pausa (botón de activar, pausa y volumen). Sin fichero aplicable
  no se pide nada; `/audio/<inexistente>` devuelve 404.

### Rendimiento
- **Tailwind precompilado** (`11a95e6`): `tailwind.css` generado una vez y commiteado en lugar del CDN que
  compilaba en el navegador. Mismo aspecto (comparado píxel a píxel) y carga de la página ~5× más rápida.
  Regenerar con `npm run build:css`.

### Operación / pruebas
- Volumen `./audio:/app/audio:ro` en `docker-compose.yml`; el `Dockerfile` copia `tailwind.css`.
- Scripts de ensayo ampliados: navegador real (`rehearsal-browser.js`), estado del cliente
  (`test-client-state.js`), límite de subida (`test-upload-limit.js`), y en `rehearsal.js` User-Agent de
  navegador, `--authors` / `--photos-per-author` e integridad por ronda.

## Robustez para evento en directo (`ef3e9b9`, `009abce`, `6b184f5`)

### Bloqueantes corregidos
- **Crash por payload malformado**: un `join`/`vote` con tipos inesperados tumbaba el proceso. Ahora se validan tipos, cada handler de socket va envuelto en try/catch y hay red de seguridad `uncaughtException`.
- **Doble "Siguiente" saltaba fotos**: `/api/game/next` solo funciona desde `revealed`.
- **Rate limit global detrás del proxy**: eliminado en `/api/upload` (ya protegido por auth admin). `trust proxy` configurado (`TRUST_PROXY`) para que el limitador de login vea la IP real.

### Funcional
- **Resultado de ronda al reconectar**: `vote_status` incluye el resultado (acierto/puntos/autor) si la foto ya está revelada.
- **Confirmación de voto**: el voto usa ack del servidor; el cliente muestra "Enviando…", reintenta hasta 5 veces (re-join si hace falta) y avisa si la votación ya se cerró. Votos duplicados son idempotentes; votos para una foto anterior se rechazan.
- **Contador fantasma**: el denominador "X/Y votos" es jugadores online ∪ los que ya votaron, no todos los jugadores históricos.
- **Errores de subida visibles**: progreso por foto, resumen y alerta con el motivo (incl. 413 no-JSON del proxy). Backend devuelve 413/400 JSON y valida que el autor existe.
- **Candado de borrado**: no se pueden borrar fotos/autores fuera del lobby (409).
- **Historial duplicado**: flag `archived` evita archivar la misma partida en finish + reset o doble finish.
- Jugador con varias pestañas ya no aparece offline al cerrar una (rooms por jugador).
- Nombre inválido tras sanitizar → `join_error` visible en vez de "unido" fantasma.
- Indicador "Reconectando…" en la vista de jugador.

### Configuración / operación
- `MAX_UPLOAD_MB` (entonces 14 por defecto; desde `8f14c0d`, 5), `TRUST_PROXY` en docker-compose y `.env.example`.
- Purga automática: log explícito al arrancar y antes de borrar; nunca purga con partida en curso.
- `GET /api/admin/whoami` (admin) para validar la IP que ve Express.
- `rehearsal.js`: ensayo general automatizado (joins en ráfaga, votos con ack, reconexiones forzadas, voto doble/tardío, coherencia de contadores, reinicio a mitad de partida, historial).

# Photo Quiz

Aplicación web para eventos de grupos fotográficos: los participantes adivinan quién tomó cada foto.
Funciona en tiempo real desde el móvil de cada jugador, con una pantalla TV para la sala y un panel de
administración. Pensada para 15–20 jugadores simultáneos en la misma WiFi.

## Flujo del juego

1. El **admin** crea autores y sube sus fotos desde el panel de administración.
2. Los **jugadores** entran escaneando el QR de la pantalla TV (o abriendo la URL) y eligen un nombre.
3. El admin **empieza** el juego: las fotos se barajan y se muestran una a una en la TV.
4. Cada jugador **vota** en su móvil quién cree que hizo la foto.
5. Se **revela** el autor: la TV muestra el nombre y el ranking; cada móvil ve si acertó.
6. **Siguiente** foto, hasta acabar → ranking final. La partida se guarda en el historial.

Revelar y pasar de foto lo hace el admin (**modo manual**, por defecto) o el servidor solo (**modo
automático**, ver [Modo de avance](#modo-de-avance-manual-o-automático)).

Puntuación: **+3 puntos por acierto**, 0 por fallo.

## Arquitectura

```
  Jugadores (móvil) ─┐
  TV (navegador) ────┼──► reverse proxy (HTTPS) ──► contenedor Docker :3001
  Admin (navegador) ─┘                               Node.js · Express · Socket.io
                                                     ├─ /            index.html + tailwind.css
                                                     ├─ /api/*       API REST
                                                     ├─ /socket.io/* tiempo real (WebSocket)
                                                     ├─ /photos/*    ./photos  (bind mount)
                                                     ├─ /audio/*     ./audio   (bind mount, solo lectura)
                                                     └─ SQLite       ./data/quiz.db (bind mount, WAL)
```

- **Un único contenedor sirve todo**: frontend, API, WebSocket, fotos y audio. Delante basta un reverse
  proxy que termine HTTPS y reenvíe todo al puerto 3001 (incluido el upgrade a WebSocket de `/socket.io/`).
  No hace falta nginx ni ningún servidor web adicional en el host.
- **Frontend**: un solo `index.html` con Alpine.js. Los estilos son Tailwind **precompilado** en
  `tailwind.css` (sin CDN de Tailwind ni compilación en el navegador). Alpine, Socket.io client y la
  librería del QR se cargan de CDN.
- **Backend**: Node.js 20 + Express + Socket.io. **BD**: SQLite (better-sqlite3) en modo WAL. El estado de
  la partida y las puntuaciones están en la BD: sobreviven a un reinicio del contenedor.
- **Imágenes**: se suben por HTTP multipart y se sirven como estáticos. Por Socket.io solo viajan eventos
  ligeros (estado, autores, recuentos de votos). Los móviles de los jugadores **no descargan las fotos**
  (se ven en la TV).

## Requisitos

- Docker y Docker Compose (plugin `docker compose`).
- Un reverse proxy con HTTPS delante (cualquiera que soporte WebSocket).
- Probado en Debian 12 (LXC).

## Instalación

```bash
# 1. Docker (Debian)
apt update && apt install -y ca-certificates curl gnupg git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 2. Código (elige el directorio; en los ejemplos, <directorio-del-proyecto>)
git clone <url-del-repo> <directorio-del-proyecto>
cd <directorio-del-proyecto>
git checkout <rama>

# 3. Configuración
cp .env.example .env
nano .env                      # como mínimo, cambia ADMIN_PASSWORD
mkdir -p photos data audio

# 4. Arrancar
docker compose up -d --build
docker compose logs --tail 20  # debe salir "Photo Quiz server running on port 3001"
```

Después configura el reverse proxy para que `https://<tu-dominio>` apunte a `http://<IP_DEL_CONTENEDOR>:3001`
y entra en `https://<tu-dominio>/?view=admin` para configurar la **URL pública del juego** (Ajustes), que es
la que aparece en el QR de la TV. Debe ser `https://<tu-dominio>`, accesible desde los móviles.

### Reverse proxy: lo que necesita

- Reenviar **todas** las rutas al contenedor (`/`, `/api/`, `/socket.io/`, `/photos/`, `/audio/`, `/tailwind.css`).
- **WebSocket** en `/socket.io/` (cabeceras `Upgrade`/`Connection`). Socket.io envía un ping cada 25 s, así
  que cualquier idle timeout ≥ 60 s basta.
- **Tamaño de petición** ≥ unos MB por encima de `MAX_UPLOAD_MB` (p. ej. 16 MB) para las subidas.
- Enviar `X-Forwarded-For` con la IP real del cliente y **no** fiarse del que mande el propio cliente.
  Comprobación (con token de admin): `GET /api/admin/whoami` → `ip` debe ser la IP real del jugador, no la
  del proxy ni la de la red de Docker.

## Actualizar (despliegue)

```bash
cd <directorio-del-proyecto>
git pull --ff-only
docker compose up -d --build
docker compose logs --tail 40      # sin errores y con "[Auto-purge] disabled" (si no la activaste)
```

El `--build` es necesario: `server.js`, `index.html` y `tailwind.css` van dentro de la imagen. Las fotos, la BD
y los MP3 están en bind mounts y se conservan. Las migraciones de la BD (columnas nuevas) se aplican solas al
arrancar. Para volver atrás: `git checkout <commit-anterior> && docker compose up -d --build`.

## Configuración (`.env`)

| Variable | Por defecto | Qué hace |
|---|---|---|
| `ADMIN_PASSWORD` | `photoquiz` | Contraseña del panel admin. **Cámbiala.** El arranque avisa en el log si sigue la de por defecto. |
| `MAX_UPLOAD_MB` | `5` | Tamaño máximo por foto en MB. Por encima, el servidor responde `413` con JSON (`code: FILE_TOO_LARGE`) y el panel lo avisa antes de subir. Se expone en `/api/state` (`maxUploadMB`) para que el frontend use el mismo límite. Para cambiarlo: editar `.env` y `docker compose up -d` (sin rebuild). |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Qué proxies se consideran de confianza para leer `X-Forwarded-For` (formato de Express `trust proxy`: rangos, IPs o nº de saltos). El valor por defecto confía en redes privadas, que es donde suelen estar el proxy y la red de Docker. |
| `ALLOWED_ORIGINS` | *(vacío = todos)* | Orígenes CORS permitidos para Socket.io, separados por comas. **Nota:** `docker-compose.yml` no la pasa al contenedor; si la necesitas, añádela a su sección `environment`. |
| `PORT`, `NODE_ENV` | `3001`, `production` | Fijadas en `docker-compose.yml` (valores de `.env` ignorados). En `production` los errores 500 no muestran detalles. |

Otras protecciones: el login de admin admite 5 intentos por minuto y por IP; los tokens de admin viven en
memoria (tras reiniciar el contenedor hay que volver a entrar).

## Uso

| Vista | URL |
|---|---|
| Selector de rol | `https://<tu-dominio>/` |
| Jugador | `https://<tu-dominio>/?view=player` |
| Pantalla TV | `https://<tu-dominio>/?view=tv` |
| Panel admin | `https://<tu-dominio>/?view=admin` |

### Panel admin

- **Juego**: crear/borrar autores, subir varias fotos a la vez por autor (con progreso y aviso por cada foto
  que falle o pase del límite), jugadores conectados, **fusionar jugadores duplicados**, controles
  (Empezar · Revelar · Siguiente · Terminar · Resetear), **interruptor manual/automático** con cuenta atrás,
  y ranking. Durante una partida no se pueden borrar fotos ni autores (hay que resetear antes).
- **Estadísticas**: historial de partidas terminadas (se archiva al terminar o resetear una partida con
  votos; nunca se duplica).
- **Ajustes**: URL pública del juego (QR), modo de avance y sus tiempos, temática visual, estado de la música
  de la TV, purga automática (desactivada por defecto) y borrado manual (datos de juego, o todo incluido el
  historial).
- **Ayuda**: guía breve para llevar el evento (flujo, duplicados y cómo fusionarlos, modos de avance,
  temáticas y música, limpieza). Solo visible tras entrar como admin.

#### Ajustes del panel (se guardan en la BD)

| Ajuste | Valores | Por defecto | Notas |
|---|---|---|---|
| URL pública del juego | URL | *(vacía)* | Contenido del QR de la TV. Terminada en `?view=player`, lleva directo a poner el nombre. |
| Modo de avance | manual / automático | manual | También se cambia en caliente desde *Juego*. |
| Pausa tras revelar | 1–10 s | 3 s | Solo modo automático: tiempo entre revelar y pasar de foto. |
| Tiempo máximo por foto | 10–600 s | 60 s | Solo modo automático: red de seguridad; revela aunque falten votos. |
| Temática visual | ninguna / halloween / navidad | ninguna | Cosmética, en TV y móviles al instante. |
| Purga automática | días | desactivada | Nunca borra con una partida en curso. |

### Comportamiento en directo

- Los clientes reciben por WebSocket el estado completo, **incluida la lista de autores**: una TV o un
  móvil abiertos antes de que el admin cree los autores muestran botones y barras sin recargar.
- **Votos confirmados por el servidor**: el móvil muestra "Enviando voto…" y reintenta solo si la conexión
  falla; un voto repetido no cuenta dos veces y uno tardío (ya revelada la foto) se rechaza con aviso.
- **Reconexión**: si un móvil pierde la red ve "Reconectando…"; al volver recupera la foto actual, si ya
  votó y, si la foto ya se reveló, su resultado.
- El contador "X/Y votos recibidos" cuenta solo jugadores conectados (o que ya votaron).
- **Identidad del jugador**: el móvil guarda su `playerId` en `localStorage`. Al recargar, cerrar la pestaña,
  bloquear el móvil o perder la red, vuelve como el **mismo** jugador (nombre, votos y puntos). Si el
  almacenamiento está bloqueado (algún modo privado), el juego funciona igual pero sin recordarlo.
  **Límite:** no cubre cambiar de navegador o de dispositivo. El caso típico es escanear el QR con la app de la
  cámara (vista temporal que se cierra al cambiar de app) y volver por el navegador normal: entra un jugador
  nuevo con el mismo nombre. Se evita pidiendo que abran el enlace en su navegador habitual, y se arregla
  fusionando.
- **Fusionar duplicados** (*Juego* → «Fusionar jugadores duplicados», `POST /api/admin/players/merge`): eliges
  un destino y uno o varios a fusionar. Se suman puntos y votos. Si ambos votaron la misma foto queda un solo
  voto (el del destino, o si no, el del primer fusionado) y sus puntos no se duplican. Los fusionados
  desaparecen de la lista y del ranking; si su móvil vuelve con el id antiguo, entra como el destino.

### Modo de avance: manual o automático

- **Manual** (por defecto): el admin revela y pasa de foto.
- **Automático**: lo decide el servidor, igual para TV, admin y jugadores.
  - Revela en cuanto han votado **todos los jugadores conectados** (la misma noción que el contador de la
    TV). Si un jugador se desconecta y con eso ya votaron todos los demás, revela; se esperan 1,5 s para que
    una recarga no cuente como irse.
  - Tras la **pausa** pasa a la siguiente foto; tras la última, al ranking final.
  - **Anti-bloqueo**: si no votan todos, al cumplirse el **tiempo máximo por foto** revela igualmente. Sin
    nadie conectado no revela por votos; espera a ese tiempo máximo.
  - **El admin siempre puede intervenir**: Revelar, Siguiente y Terminar se adelantan a la cuenta atrás, y el
    automático continúa desde ahí sin duplicar nada.
  - Hay un único temporizador pendiente, ligado a la foto y fase. Lo cancelan las acciones manuales, el cambio
    de modo, terminar, resetear y borrar. Tras reiniciar el servidor, el modo automático se reanuda.
- La TV muestra «Siguiente foto en N s» / «Ranking final en N s»; el admin ve también el tiempo máximo.
  El estado (`state_update`, `/api/state`) incluye `autoMode`, `autoDelay`, `autoTimeout` y `autoPending`.

### Ayuda para los jugadores

- La pantalla de inicio destaca **Jugar** como acción principal; TV y Admin quedan como accesos secundarios.
- Antes de entrar se pide el nombre con una indicación clara y un botón **Entrar** grande.
- Mientras esperan a que empiece, el móvil muestra en 3 líneas cómo se juega. Al empezar la partida da paso
  a los botones de voto.
- En la espera y durante la partida, bajo «Jugando como», un recordatorio: «No cierres esta página ni cambies
  de app para no perder tu sitio». Al volver de otra app tras más de 1 s, aviso efímero «¡De nuevo aquí!».

## Temática visual y música de la TV

- **Temática** (Admin → Ajustes → *Temática visual*): `Ninguna` (por defecto), `🎃 Halloween`, `🎄 Navidad`.
  Cambia colores, fondos y títulos de la TV, los móviles y el panel admin. Se aplica al instante, sin recargar.
  Es puramente estética: no toca el juego. `Ninguna` es el aspecto original (sin ninguna regla aplicada).
  - **Halloween**: noche morada casi negra, acento naranja calabaza, títulos con tipografía terrorífica.
    En la TV, murciélagos cruzando la parte alta.
  - **Navidad**: crema, rojo, verde abeto y dorado. Móvil claro con cabecera roja; TV en verde abeto con
    guirnalda de luces. En la TV, nieve cayendo.
  - Las animaciones son **solo de la TV** (un único canvas; no corren fuera de su tema y se desactivan si el
    sistema pide reducir el movimiento). Móviles y admin solo cambian de color, sin animaciones.
  - Las tipografías de los títulos se cargan de Google Fonts sin bloquear la página; si no llegan, se usa la
    fuente de reserva.
- **Música (solo en la TV; los móviles nunca reproducen audio)**: deja los MP3 en la carpeta `audio/` del
  proyecto (montada en el contenedor como `/app/audio`, solo lectura). No se versionan (`.gitignore`) y no
  hace falta rebuild ni reinicio.

  | Temática  | Fichero preferido      | Si no existe          |
  |-----------|------------------------|-----------------------|
  | Ninguna   | `audio/ambient.mp3`    | sin música            |
  | Halloween | `audio/halloween.mp3`  | `audio/ambient.mp3`   |
  | Navidad   | `audio/navidad.mp3`    | `audio/ambient.mp3`   |

  `ambient.mp3` es el **fallback común**: con solo ese fichero hay música en las tres temáticas.
  La TV muestra arriba a la izquierda **🔈 Activar música**: los navegadores no permiten sonar sin una
  interacción previa, así que hay que pulsarlo una vez al montar la TV. Después: **⏸ Pausa** y control de
  volumen (empieza al 30 %). La pista suena en bucle y cambia sola al cambiar de temática. Si no hay ningún
  fichero aplicable, la TV muestra *🎵 Sin música* y no hace ninguna petición. Los MP3 se sirven por
  rangos (la TV no descarga el fichero entero antes de sonar).

## Estilos (Tailwind precompilado)

`tailwind.css` (Tailwind v3.4.17, ~21 KB, ~4 KB gzip) se genera a partir de `index.html` y **se commitea**:
no hay paso de build en el despliegue. Si añades o cambias clases en `index.html`:

```bash
npm install          # una vez (tailwindcss es devDependency; no entra en la imagen)
npm run build:css    # regenera tailwind.css
git add tailwind.css # y commitea
```

Las clases deben aparecer escritas completas en `index.html` (también dentro de `:class`); si se construyen
concatenando strings, no se generarán.

## Comandos de gestión

```bash
cd <directorio-del-proyecto>

docker compose up -d                 # arrancar
docker compose down                  # parar
docker compose restart               # reiniciar (el estado de la partida se conserva en la BD)
docker compose logs -f               # logs en tiempo real
docker compose ps                    # estado del contenedor
docker compose up -d --build         # reconstruir tras actualizar el código

# Copia de seguridad de la BD (mejor con la app en lobby)
cp -a data data.bak-$(date +%F)
```

Para empezar de cero usa el panel admin (**Ajustes → Borrar datos** o **Borrar TODO**), que borra fotos y
datos de forma consistente. Como último recurso, con el contenedor parado:
`docker compose down && rm -f data/quiz.db* && rm -f photos/* && docker compose up -d`.

## Solución de problemas

- **El contenedor no arranca**: `docker compose logs --tail 50`. Comprueba que `photos/` y `data/` son
  escribibles por el usuario del contenedor (uid 1000): `chown -R 1000:1000 photos data`.
- **Socket.io no conecta / se queda en "Reconectando…"**: el reverse proxy debe permitir el upgrade a
  WebSocket en `/socket.io/`. Comprueba también `docker compose ps`.
- **El QR no aparece**: configura la URL pública en Ajustes; debe ser accesible desde los móviles.
- **Una foto no sube**: el panel indica el motivo. Si es por tamaño, reduce la foto o sube `MAX_UPLOAD_MB`
  (y el límite del proxy).
- **No suena la música**: revisa en Ajustes el estado de la música; el fichero debe estar en `audio/` con el
  nombre exacto, y hay que pulsar *Activar música* en la TV.
- **La purga automática**: si la activas en Ajustes, el arranque lo anuncia en el log y nunca borra con una
  partida en curso.

## Pruebas

El repositorio incluye scripts de ensayo y carga para desarrollo (`rehearsal.js`, `rehearsal-browser.js`,
`test-*.js` —entre ellos `test-identity-merge.js` y `test-auto-advance.js`—, `simulate.sh`, `test-load.js`), que se ejecutan con Node desde fuera del contenedor contra una
instancia **de pruebas** (escriben datos). Ver la cabecera de cada script para su uso.

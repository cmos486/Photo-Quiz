# Photo Quiz

Aplicación web para eventos de grupos fotográficos. Los participantes deben adivinar quién tomó cada foto. Funciona en tiempo real con 15+ usuarios simultáneos.

## Flujo del juego

1. **Admin** sube fotos organizadas por autor desde el panel de administración
2. **Jugadores** entran escaneando el QR en la pantalla TV (o accediendo a la URL)
3. **Admin** inicia el juego → las fotos se muestran en orden aleatorio
4. **Jugadores** votan en sus móviles quién creen que tomó la foto
5. **Admin** revela el autor → se muestran puntuaciones
6. Se repite hasta agotar las fotos → ranking final

Puntuación: +3 puntos por acierto, 0 por fallo.

## Arquitectura

```
                    ┌─────────────┐
  Jugadores ──────► │   nginx     │ ◄────── TV / Admin
  (móvil)           │  (host)     │         (navegador)
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        /index.html   /photos/*    /api/* + /socket.io/*
        (estático)    (bind mount)  (proxy → :3001)
              │            │            │
              │            │     ┌──────┴──────┐
              │            │     │  Container  │
              │            │     │  Node.js    │
              │            │     │  Express    │
              │            │     │  Socket.io  │
              │            │     └──────┬──────┘
              │            │            │
              │      /opt/photo-quiz/   │
              │        photos/     data/quiz.db
              │      (bind mount)  (bind mount)
```

- **Frontend**: HTML único con Alpine.js + Tailwind CSS (CDN, sin build step)
- **Backend**: Node.js + Express + Socket.io en Docker
- **BD**: SQLite con WAL mode
- **Imágenes**: Subida HTTP multipart, servidas por nginx como estáticos (NUNCA por Socket.io)
- **Tiempo real**: Socket.io solo para eventos ligeros (URLs, conteos, estados)

## Requisitos previos

- Docker y Docker Compose
- nginx instalado en el host
- Debian/Ubuntu (probado en LXC)

## Instalación paso a paso (Debian LXC)

### 1. Instalar Docker

```bash
apt update && apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

### 2. Instalar nginx (si no existe)

```bash
apt install -y nginx
```

### 3. Desplegar la aplicación

```bash
# Crear directorios
mkdir -p /opt/photo-quiz /var/www/quiz

# Copiar archivos del proyecto a /opt/photo-quiz/
# (docker-compose.yml, Dockerfile, server.js, package.json, test-load.js)

# Copiar frontend
cp index.html /var/www/quiz/index.html

# Crear carpetas de datos
mkdir -p /opt/photo-quiz/photos /opt/photo-quiz/data
```

### 4. Configurar nginx

Crear `/etc/nginx/sites-available/quiz`:

```nginx
server {
    listen 80;
    server_name _;

    # Frontend estático
    root /var/www/quiz;
    index index.html;

    # Fotos subidas (servidas directamente desde bind mount del host)
    location /photos/ {
        alias /opt/photo-quiz/photos/;
        expires 1d;
        add_header Cache-Control "public";
    }

    # API REST al contenedor
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        client_max_body_size 10M;
    }

    # Socket.io al contenedor
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

Activar:

```bash
ln -sf /etc/nginx/sites-available/quiz /etc/nginx/sites-enabled/quiz
rm -f /etc/nginx/sites-enabled/default  # opcional
nginx -t && systemctl reload nginx
```

### 5. Arrancar la aplicación

```bash
cd /opt/photo-quiz
docker compose up -d
```

### 6. Configurar la URL pública

Accede al panel Admin (`http://TU_IP/?view=admin`) y configura la URL pública del juego (la que aparecerá en el QR de la TV).

## Comandos de gestión

```bash
# Arrancar
cd /opt/photo-quiz && docker compose up -d

# Parar
docker compose down

# Ver logs en tiempo real
docker compose logs -f

# Reset completo (borra partida y fotos)
docker compose down
rm -rf ./data/quiz.db ./photos/*
docker compose up -d

# Actualizar tras cambios en server.js
docker compose build && docker compose up -d

# Test de carga
docker compose exec app node test-load.js
```

## Cambiar la URL pública del juego

1. Acceder a `http://TU_IP/?view=admin`
2. En la sección "URL Pública del Juego", introducir la URL completa
3. Clic en "Guardar"
4. El QR de la pantalla TV se actualizará automáticamente

## URLs de acceso

| Vista | URL |
|-------|-----|
| Selector de rol | `http://TU_IP/` |
| Jugador directo | `http://TU_IP/?view=player` |
| Pantalla TV | `http://TU_IP/?view=tv` |
| Panel Admin | `http://TU_IP/?view=admin` |

## Solución de problemas

### El contenedor no arranca
```bash
docker compose logs -f  # Ver errores
docker compose down && docker compose up -d  # Reiniciar
```

### Socket.io no conecta
- Verificar que nginx tiene la sección `/socket.io/` con los headers de upgrade
- `nginx -t && systemctl reload nginx`
- Verificar que el contenedor está corriendo: `docker compose ps`

### Las fotos no se ven
- Verificar que `/opt/photo-quiz/photos/` contiene archivos
- Verificar que nginx tiene `location /photos/` con `alias` correcto
- Verificar permisos: `ls -la /opt/photo-quiz/photos/`

### Error de base de datos
```bash
# Si la BD se corrompe, resetear:
docker compose down
rm -f ./data/quiz.db
docker compose up -d
```

### El QR no aparece
- Configurar la URL pública en el panel Admin primero
- La URL debe ser accesible desde los móviles de los jugadores (misma red WiFi)

### Reconexión de jugadores
Socket.io reconecta automáticamente. Si un jugador pierde señal WiFi, al recuperarla se reconectará y recibirá el estado actual del juego.

## Nota sobre uso

Esta aplicación está diseñada para usarse ocasionalmente en eventos fotográficos. Docker garantiza que `docker compose up -d` funcione sin problemas independientemente de cuánto tiempo haya pasado desde el último uso.

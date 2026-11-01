# Música de fondo (solo vista TV)

Deja aquí los MP3 (no se versionan). La TV usa la pista según la temática activa:

| Temática  | Fichero          |
|-----------|------------------|
| ninguna   | `ambient.mp3`    |
| halloween | `halloween.mp3`  |
| navidad   | `navidad.mp3`    |

En producción la carpeta es `/root/photo-quiz/audio/` (bind mount de solo lectura en el
contenedor). No hace falta reiniciar ni reconstruir: la TV detecta el fichero en el siguiente
cambio de estado o al recargar. Si falta el fichero, la TV no reproduce nada y no da error.

# Música de fondo (solo vista TV)

Deja aquí los MP3 (no se versionan). La TV usa la pista según la temática activa:

| Temática  | Fichero          |
|-----------|------------------|
| ninguna   | `ambient.mp3`    |
| halloween | `halloween.mp3`  |
| navidad   | `navidad.mp3`    |

`ambient.mp3` es el fallback común: si falta el MP3 de la temática activa se usa `ambient.mp3`.

Esta carpeta se monta en el contenedor como `/app/audio` (solo lectura). No hace falta reiniciar ni
reconstruir: la TV detecta el fichero en el siguiente cambio de estado o al recargar. Si no hay
ningún fichero aplicable, la TV no reproduce nada y no da error.

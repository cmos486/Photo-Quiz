# Changelog — rama review-evento

## Robustez para evento en directo

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
- `MAX_UPLOAD_MB` (default 14), `TRUST_PROXY` en docker-compose y `.env.example`.
- Purga automática: log explícito al arrancar y antes de borrar; nunca purga con partida en curso.
- `GET /api/admin/whoami` (admin) para validar la IP que ve Express.
- `rehearsal.js`: ensayo general automatizado (joins en ráfaga, votos con ack, reconexiones forzadas, voto doble/tardío, coherencia de contadores, reinicio a mitad de partida, historial).

#!/bin/bash
# Simulation: 20 authors, 20 real photos, 20 players, full game
set -e

BASE="http://localhost:3001"
ADMIN_PASS="${ADMIN_PASSWORD:-photoquiz}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR; kill $PLAYER_PID 2>/dev/null; exec 3>&- 2>/dev/null" EXIT

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${CYAN}[>>]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

AUTHORS=(
  "Ana García" "Carlos López" "María Ruiz" "Pedro Sánchez" "Laura Martín"
  "Diego Torres" "Sofía Moreno" "Javier Gil" "Elena Díaz" "Pablo Navarro"
  "Lucía Romero" "Andrés Molina" "Carmen Ortega" "Raúl Jiménez" "Isabel Serrano"
  "Hugo Blanco" "Marta Reyes" "David Castro" "Paula Herrera" "Álvaro Muñoz"
)

# Verify server
info "Verificando servidor..."
curl -sf "$BASE/api/state" > /dev/null || fail "Servidor no responde en $BASE"
log "Servidor OK"

# ---- Admin Login ----
info "Autenticando como admin..."
LOGIN_RESP=$(curl -sf -X POST "$BASE/api/admin/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\": \"$ADMIN_PASS\"}" 2>/dev/null) || fail "Error de login. ¿Contraseña correcta? (usa ADMIN_PASSWORD=xxx)"
TOKEN=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
[ -n "$TOKEN" ] || fail "No se obtuvo token de admin"
log "Admin autenticado"

# Helper: admin curl (adds auth header)
acurl() {
  curl -sf -H "X-Admin-Token: $TOKEN" "$@"
}

echo ""
echo "============================================="
echo "  SIMULACIÓN: 20 autores, 20 fotos REALES, 20 jugadores"
echo "============================================="
echo ""

# ---- Clean ----
info "Limpiando datos anteriores..."
acurl -X POST "$BASE/api/admin/purge" \
  -H "Content-Type: application/json" \
  -d '{"includeHistory": false}' > /dev/null
log "Datos limpiados"

# ---- Create 20 authors ----
info "Creando 20 autores..."
declare -a AUTHOR_IDS
for i in "${!AUTHORS[@]}"; do
  RESP=$(acurl -X POST "$BASE/api/authors" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"${AUTHORS[$i]}\"}")
  AID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
  AUTHOR_IDS+=("$AID")
done
log "20 autores creados"

# ---- Download 20 real photos from picsum.photos ----
info "Descargando 20 fotos reales de picsum.photos (1920x1080)..."
echo ""

# Use different picsum IDs for variety (landscape-friendly photos)
PHOTO_IDS=(10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29)

for i in "${!AUTHORS[@]}"; do
  IMGFILE="$TMPDIR/photo_${i}.jpg"
  PID=${PHOTO_IDS[$i]}

  # Download a specific photo by ID (deterministic, avoids duplicates)
  HTTP_CODE=$(curl -sL -o "$IMGFILE" -w "%{http_code}" "https://picsum.photos/id/${PID}/1920/1080")

  if [ "$HTTP_CODE" = "200" ] && [ -s "$IMGFILE" ]; then
    FILESIZE=$(du -h "$IMGFILE" | cut -f1)
    echo -e "  ${GREEN}✓${NC} Foto $((i+1))/20 descargada (${FILESIZE}B) — picsum #${PID} → ${AUTHORS[$i]}"
  else
    # Fallback: use random photo if specific ID fails
    curl -sL -o "$IMGFILE" "https://picsum.photos/1920/1080?random=$i"
    FILESIZE=$(du -h "$IMGFILE" | cut -f1)
    echo -e "  ${YELLOW}~${NC} Foto $((i+1))/20 (fallback random, ${FILESIZE}B) → ${AUTHORS[$i]}"
  fi

  # Upload to server
  acurl -X POST "$BASE/api/upload" \
    -F "photo=@$IMGFILE" \
    -F "author_id=${AUTHOR_IDS[$i]}" > /dev/null
done

echo ""
log "20 fotos reales subidas"

# ---- Verify ----
info "Verificando estado..."
STATE=$(curl -sf "$BASE/api/state")
NUM_AUTHORS=$(echo "$STATE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['authors']))")
NUM_PHOTOS=$(echo "$STATE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['photos']))")
[ "$NUM_AUTHORS" = "20" ] && log "20 autores confirmados" || fail "Se esperaban 20 autores, hay $NUM_AUTHORS"
[ "$NUM_PHOTOS" = "20" ] && log "20 fotos confirmadas" || fail "Se esperaban 20 fotos, hay $NUM_PHOTOS"

# Show total size
TOTAL_SIZE=$(curl -sf "$BASE/api/state" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f'{len(data[\"photos\"])} fotos cargadas en el servidor')
")
log "$TOTAL_SIZE"

# ---- Connect 20 players ----
info "Conectando 20 jugadores via Socket.io..."

FIFO="$TMPDIR/cmd_pipe"
mkfifo "$FIFO"

node "$SCRIPT_DIR/sim-players.js" "$BASE" < "$FIFO" > "$TMPDIR/player_output.log" 2>&1 &
PLAYER_PID=$!

exec 3>"$FIFO"

sleep 4

CONN_LINE=$(tail -1 "$TMPDIR/player_output.log" 2>/dev/null)
CONN_COUNT=$(echo "$CONN_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count',0))" 2>/dev/null || echo "0")
log "$CONN_COUNT jugadores conectados via Socket.io"

STATE=$(curl -sf "$BASE/api/state")
NUM_PLAYERS=$(echo "$STATE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['players']))")
log "$NUM_PLAYERS jugadores registrados en BD"

# ---- Start game ----
echo ""
info "========== INICIANDO JUEGO =========="
acurl -X POST "$BASE/api/game/start" > /dev/null
log "Juego iniciado"
sleep 1

# ---- Play 20 photos ----
for PHOTO_NUM in $(seq 1 20); do
  echo ""
  info "--- Foto $PHOTO_NUM de 20 ---"

  STATE=$(curl -sf "$BASE/api/state")
  GAME_STATE=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['session']['state'])")

  if [ "$GAME_STATE" != "playing" ]; then
    warn "Estado inesperado: $GAME_STATE (esperado: playing)"
  fi

  # Players vote
  echo "VOTE" >&3
  sleep 2

  # Check votes
  STATE=$(curl -sf "$BASE/api/state")
  VOTERS=$(echo "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['totalVoters'])")
  log "Votos recibidos: $VOTERS/20"

  # Reveal
  REVEAL=$(acurl -X POST "$BASE/api/game/reveal")
  AUTHOR=$(echo "$REVEAL" | python3 -c "import sys,json; print(json.load(sys.stdin).get('authorName','?'))")
  log "Autor revelado: $AUTHOR"
  sleep 1

  # Next or last
  if [ "$PHOTO_NUM" -lt 20 ]; then
    acurl -X POST "$BASE/api/game/next" > /dev/null
    log "Siguiente foto"
    sleep 1
  fi
done

# ---- Finish ----
echo ""
info "========== TERMINANDO JUEGO =========="
acurl -X POST "$BASE/api/game/finish" > /dev/null
log "Juego terminado"

# ---- Final ranking ----
echo ""
echo "============================================="
echo "           RANKING FINAL"
echo "============================================="
STATE=$(curl -sf "$BASE/api/state")
echo "$STATE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
players = sorted(data['players'], key=lambda p: p['score'], reverse=True)
medals = ['🥇','🥈','🥉']
for i, p in enumerate(players):
    medal = medals[i] if i < 3 else f'  {i+1:>2}'
    print(f'  {medal}  {p[\"name\"]:20s}  {p[\"score\"]:3d} pts')
"

# ---- Verify history ----
echo ""
info "Verificando historial..."
HISTORY=$(acurl "$BASE/api/admin/history")
echo "$HISTORY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
games = data['games']
print(f'  Partidas en historial: {len(games)}')
if games:
    g = games[0]
    print(f'  Última: Partida #{g[\"id\"]} - {g[\"total_players\"]} jugadores, {g[\"total_photos\"]} fotos')
    for i, p in enumerate(g['players'][:5]):
        medal = ['🥇','🥈','🥉'][i] if i < 3 else f'  {i+1:>2}'
        print(f'    {medal}  {p[\"player_name\"]:20s}  {p[\"score\"]:3d} pts  ({p[\"correct_votes\"]}/{p[\"total_votes\"]} aciertos)')
    if len(g['players']) > 5:
        print(f'    ... y {len(g[\"players\"]) - 5} más')
"

# Cleanup
echo "QUIT" >&3
exec 3>&-
wait $PLAYER_PID 2>/dev/null || true

echo ""
echo "============================================="
echo -e "  ${GREEN}✓ SIMULACIÓN COMPLETADA CON ÉXITO${NC}"
echo "============================================="
echo ""
echo "  Verifica visualmente en:"
echo "    TV:    $BASE/?view=tv"
echo "    Admin: $BASE/?view=admin"
echo ""

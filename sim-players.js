const io = require("socket.io-client");

const BASE = process.argv[2] || "http://localhost:3001";
const players = [];
const NUM = 20;
let globalAuthors = [];

const NAMES = [
  "Player_Alpha","Player_Beta","Player_Gamma","Player_Delta","Player_Epsilon",
  "Player_Zeta","Player_Eta","Player_Theta","Player_Iota","Player_Kappa",
  "Player_Lambda","Player_Mu","Player_Nu","Player_Xi","Player_Omicron",
  "Player_Pi","Player_Rho","Player_Sigma","Player_Tau","Player_Upsilon"
];

// Fetch authors via HTTP (they aren't sent via socket)
async function fetchAuthors() {
  try {
    const resp = await fetch(`${BASE}/api/state`);
    const data = await resp.json();
    globalAuthors = data.authors || [];
  } catch (e) {
    console.error("Error fetching authors:", e.message);
  }
}

for (let i = 0; i < NUM; i++) {
  const socket = io(BASE, { transports: ["websocket"] });
  const playerId = `sim-player-${i}`;
  players.push({ socket, playerId, name: NAMES[i], currentPhotoId: null, gameState: null });

  socket.on("connect", () => {
    socket.emit("join", { playerId, name: NAMES[i] });
  });

  socket.on("state_update", (data) => {
    players[i].currentPhotoId = data.currentPhotoId;
    players[i].gameState = data.state;
  });
}

// Wait for all to connect, fetch authors, then listen for commands
setTimeout(async () => {
  await fetchAuthors();
  const connected = players.filter(p => p.socket.connected).length;
  console.log(JSON.stringify({ phase: "connected", count: connected, authors: globalAuthors.length }));

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    for (const line of chunk.split("\n")) {
      const cmd = line.trim();
      if (!cmd) continue;

      if (cmd === "VOTE") {
        // Re-fetch authors in case they changed
        if (globalAuthors.length === 0) await fetchAuthors();

        let votes = 0;
        players.forEach((p) => {
          if (globalAuthors.length > 0 && p.currentPhotoId) {
            const randomAuthor = globalAuthors[Math.floor(Math.random() * globalAuthors.length)];
            p.socket.emit("vote", { playerId: p.playerId, authorId: randomAuthor.id });
            votes++;
          }
        });
        console.log(JSON.stringify({ phase: "voted", count: votes, photoId: players[0]?.currentPhotoId }));
      }

      if (cmd === "STATUS") {
        const sample = players[0];
        console.log(JSON.stringify({
          phase: "status",
          gameState: sample.gameState,
          photoId: sample.currentPhotoId,
          numAuthors: globalAuthors.length,
          connected: players.filter(p => p.socket.connected).length
        }));
      }

      if (cmd === "QUIT") {
        players.forEach(p => p.socket.disconnect());
        setTimeout(() => process.exit(0), 500);
      }
    }
  });
}, 3000);

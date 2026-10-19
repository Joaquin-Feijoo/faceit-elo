const express = require("express");
const axios = require("axios");

const app = express();

// Variables para FACEIT
const FACEIT_KEY = process.env.FACEIT_KEY;
const PLAYER_NICK = process.env.FACEIT_NICK;
const ELO_MESSAGE_TEMPLATE = process.env.ELO_MESSAGE;

// Variables para PREMIER
const STEAM_ID_64 = process.env.STEAM_ID_64;
const PREMIER_MESSAGE_TEMPLATE =
  process.env.PREMIER_MESSAGE ||
  "CS2 Premier | {nick} - Rating: {elo} | Hoy: {matches} partidas ({wins}W/{losses}L) - WR: {wr}% | K/D: {kd}";

const CACHE_TIME = 90000; // 90 segundos

// Cache Faceit
let cacheFaceit = null;
let lastFetchFaceit = 0;
let fetchingFaceit = null;

// Cache Premier
let cachePremier = null;
let lastFetchPremier = 0;
let fetchingPremier = null;

if (!FACEIT_KEY || !PLAYER_NICK) {
  console.error(
    "Faltan variables de entorno de Faceit (FACEIT_KEY o FACEIT_NICK)",
  );
  process.exit(1);
}

// Función auxiliar para comparar fechas (Día actual en UTC)
function isToday(dateInput) {
  const matchDate =
    typeof dateInput === "number"
      ? new Date(dateInput * 1000)
      : new Date(dateInput);
  const now = new Date();

  return (
    matchDate.getUTCFullYear() === now.getUTCFullYear() &&
    matchDate.getUTCMonth() === now.getUTCMonth() &&
    matchDate.getUTCDate() === now.getUTCDate()
  );
}

// ==========================================
// LÓGICA FACEIT
// ==========================================
async function getFaceitStats() {
  console.log("Fetching FACEIT stats...");

  const playerRes = await axios.get(
    `https://open.faceit.com/data/v4/players?nickname=${PLAYER_NICK}`,
    { headers: { Authorization: `Bearer ${FACEIT_KEY}` } },
  );

  const playerData = playerRes.data;
  const playerId = playerData.player_id;

  const game = playerData.games?.cs2 || playerData.games?.csgo;
  if (!game) throw new Error("Jugador sin datos CS");

  const elo = game.faceit_elo;

  let offset = 0;
  const limit = 20;

  let wins = 0;
  let losses = 0;
  let totalToday = 0;
  let totalKills = 0;
  let totalDeaths = 0;

  while (true) {
    const historyRes = await axios.get(
      `https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${FACEIT_KEY}` } },
    );

    const matches = historyRes.data.items;
    if (!matches.length) break;

    let foundOlderMatch = false;

    for (const match of matches) {
      if (!isToday(match.finished_at)) {
        foundOlderMatch = true;
        break;
      }

      const winner = match.results?.winner;
      if (!winner) continue;

      let playerFaction = null;

      for (const [faction, team] of Object.entries(match.teams)) {
        if (team.players.some((p) => p.player_id === playerId)) {
          playerFaction = faction;
          break;
        }
      }

      if (!playerFaction) continue;

      totalToday++;

      if (playerFaction === winner) wins++;
      else losses++;

      try {
        const matchStatsRes = await axios.get(
          `https://open.faceit.com/data/v4/matches/${match.match_id}/stats`,
          { headers: { Authorization: `Bearer ${FACEIT_KEY}` } },
        );

        const roundsData = matchStatsRes.data.rounds;
        if (roundsData && roundsData.length > 0) {
          const allPlayers = roundsData[0].teams.flatMap(
            (t) => t.players || [],
          );

          for (const p of allPlayers) {
            if (p.player_id === playerId) {
              const st = p.player_stats || {};
              totalKills += Number(st["Kills"] || st["kills"] || 0);
              totalDeaths += Number(st["Deaths"] || st["deaths"] || 0);
            }
          }
        }
      } catch (err) {
        console.error(
          "No se pudieron obtener stats del match de Faceit:",
          match.match_id,
        );
      }
    }

    if (foundOlderMatch) break;
    offset += limit;
  }

  const total = wins + losses;
  const kdRatio =
    totalDeaths > 0
      ? (totalKills / totalDeaths).toFixed(2)
      : totalKills.toFixed(2);

  return {
    nick: PLAYER_NICK,
    elo,
    matches_today: totalToday,
    wins,
    losses,
    winrate: total ? Math.round((wins / total) * 100) : 0,
    kd: kdRatio,
  };
}

async function getCachedFaceitStats() {
  const now = Date.now();
  if (cacheFaceit && now - lastFetchFaceit < CACHE_TIME) return cacheFaceit;

  if (!fetchingFaceit) {
    fetchingFaceit = getFaceitStats()
      .then((stats) => {
        cacheFaceit = stats;
        lastFetchFaceit = Date.now();
        return stats;
      })
      .finally(() => {
        fetchingFaceit = null;
      });
  }
  return fetchingFaceit;
}

// ==========================================
// LÓGICA PREMIER (LEETIFY API)
// ==========================================
async function getPremierStats() {
  console.log("Fetching PREMIER stats...");

  if (!STEAM_ID_64) {
    throw new Error(
      "STEAM_ID_64 no está definida en las variables de entorno.",
    );
  }

  // Consulta de datos de perfil y partidas desde Leetify
  const profileRes = await axios.get(
    `https://api.leetify.com/api/profile/${STEAM_ID_64}`,
  );
  const profileData = profileRes.data;

  const personaName = profileData.meta?.name || PLAYER_NICK;

  // Extraer rating de Premier
  const cs2Game = profileData.games?.find((g) => g.gameId === "cs2");
  const csRating = cs2Game?.skillLevel || profileData.skillLevel || "Sin Rango";

  // Obtener historial de partidas recientes
  const matchesRes = await axios.get(
    `https://api.leetify.com/api/profile/${STEAM_ID_64}/matches`,
  );
  const matches = matchesRes.data || [];

  let wins = 0;
  let losses = 0;
  let totalToday = 0;
  let totalKills = 0;
  let totalDeaths = 0;

  for (const match of matches) {
    // Solo tomar partidas de Matchmaking Premier
    if (match.dataSource !== "matchmaking" && match.gameMode !== "premier")
      continue;

    if (!isToday(match.gameFinishedAt)) break; // Al estar ordenado por fecha, si la partida es vieja cortamos

    totalToday++;

    // Chequear resultado de la partida
    if (match.hasWon) wins++;
    else losses++;

    // Kills y Deaths
    totalKills += Number(match.ownStats?.kills || 0);
    totalDeaths += Number(match.ownStats?.deaths || 0);
  }

  const total = wins + losses;
  const kdRatio =
    totalDeaths > 0
      ? (totalKills / totalDeaths).toFixed(2)
      : totalKills.toFixed(2);

  return {
    nick: personaName,
    elo: csRating,
    matches_today: totalToday,
    wins,
    losses,
    winrate: total ? Math.round((wins / total) * 100) : 0,
    kd: kdRatio,
  };
}

async function getCachedPremierStats() {
  const now = Date.now();
  if (cachePremier && now - lastFetchPremier < CACHE_TIME) return cachePremier;

  if (!fetchingPremier) {
    fetchingPremier = getPremierStats()
      .then((stats) => {
        cachePremier = stats;
        lastFetchPremier = Date.now();
        return stats;
      })
      .finally(() => {
        fetchingPremier = null;
      });
  }
  return fetchingPremier;
}

// ==========================================
// CONSTRUCTOR DE MENSAJES
// ==========================================
function buildMessage(template, stats) {
  return template
    .replaceAll("{nick}", stats.nick)
    .replaceAll("{elo}", stats.elo)
    .replaceAll("{matches}", stats.matches_today)
    .replaceAll("{wins}", stats.wins)
    .replaceAll("{losses}", stats.losses)
    .replaceAll("{wr}", stats.winrate)
    .replaceAll("{kd}", stats.kd);
}

// ==========================================
// RUTAS ENDPOINTS
// ==========================================

// Route FACEIT (Texto)
app.get("/elo", async (req, res) => {
  try {
    const stats = await getCachedFaceitStats();
    res.send(buildMessage(ELO_MESSAGE_TEMPLATE, stats));
  } catch (err) {
    console.error("Error en /elo:", err.message);
    res.status(500).send("Error obteniendo elo de Faceit");
  }
});

// Route PREMIER (Texto)
app.get("/premier", async (req, res) => {
  try {
    const stats = await getCachedPremierStats();
    res.send(buildMessage(PREMIER_MESSAGE_TEMPLATE, stats));
  } catch (err) {
    console.error("Error en /premier:", err.message);
    res.status(500).send("Error obteniendo datos de Premier");
  }
});

// Route STATS FACEIT (JSON)
app.get("/stats", async (req, res) => {
  try {
    const stats = await getCachedFaceitStats();
    res.json(stats);
  } catch {
    res.status(500).json({ error: "Error obteniendo stats de Faceit" });
  }
});

// Route STATS PREMIER (JSON)
app.get("/premier-stats", async (req, res) => {
  try {
    const stats = await getCachedPremierStats();
    res.json(stats);
  } catch {
    res.status(500).json({ error: "Error obteniendo stats de Premier" });
  }
});

// Servidor
app.listen(process.env.PORT || 3000, () => {
  console.log("API corriendo en el puerto", process.env.PORT || 3000);
});

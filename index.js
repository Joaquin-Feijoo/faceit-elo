const express = require("express");
const axios = require("axios");

const app = express();

// Variables de entorno para FACEIT
const FACEIT_KEY = process.env.FACEIT_KEY;
const PLAYER_NICK = process.env.FACEIT_NICK;
const ELO_MESSAGE_TEMPLATE = process.env.ELO_MESSAGE;

// Variables de entorno para PREMIER (Leetify API Oficial)
const STEAM_ID_64 = process.env.STEAM_ID_64;
const LEETIFY_KEY = process.env.LEETIFY_KEY;
const PREMIER_MESSAGE_TEMPLATE =
  process.env.PREMIER_MESSAGE ||
  "{nick} - ELO: {elo} | Today: {matches} {wins}W - {losses}L - WR: ({wr}%) | K/D today: {kd}";

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
  console.error("Faltan variables de entorno de Faceit");
  process.exit(1);
}

function isToday(timestamp) {
  const matchDate =
    typeof timestamp === "number"
      ? new Date(timestamp * 1000)
      : new Date(timestamp);
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
async function getStats() {
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

async function getCachedStats() {
  const now = Date.now();

  if (cacheFaceit && now - lastFetchFaceit < CACHE_TIME) {
    return cacheFaceit;
  }

  if (!fetchingFaceit) {
    fetchingFaceit = getStats()
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
// LÓGICA PREMIER (LEETIFY API OFICIAL)
// ==========================================
async function getPremierStats() {
  console.log("Fetching PREMIER stats desde Leetify API Oficial...");

  if (!STEAM_ID_64 || !LEETIFY_KEY) {
    console.error("Faltan variables de entorno STEAM_ID_64 o LEETIFY_KEY");
    return {
      nick: PLAYER_NICK || "Jugador",
      elo: "Sin Key",
      matches_today: 0,
      wins: 0,
      losses: 0,
      winrate: 0,
      kd: "0.00",
    };
  }

  const headers = {
    _leetify_key: LEETIFY_KEY,
    Authorization: `Bearer ${LEETIFY_KEY}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  };

  try {
    // 1. Perfil del jugador
    const profileRes = await axios.get(
      `https://api.leetify.com/api/profile/${STEAM_ID_64}`,
      { headers },
    );
    const data = profileRes.data;

    const personaName =
      data.meta?.name || data.username || PLAYER_NICK || "Jugador";

    // CS Rating de Premier
    const cs2Game = data.games?.find((g) => g.gameId === "cs2");
    const csRating =
      cs2Game?.skillLevel ||
      data.skillLevel ||
      data.ranks?.find((r) => r.gameMode === "premier")?.skillLevel ||
      "Sin Rango";

    // 2. Historial de partidas recientes
    let matches = [];
    try {
      const matchesRes = await axios.get(
        `https://api.leetify.com/api/profile/${STEAM_ID_64}/matches`,
        { headers },
      );
      matches = matchesRes.data || [];
    } catch (matchErr) {
      console.error(
        "No se pudieron cargar las partidas de Leetify:",
        matchErr.response?.status,
        matchErr.message,
      );
    }

    let wins = 0;
    let losses = 0;
    let totalToday = 0;
    let totalKills = 0;
    let totalDeaths = 0;

    for (const match of matches) {
      const isPremier =
        match.dataSource === "matchmaking" ||
        match.gameMode === "premier" ||
        match.matchmakingType === "premier";
      if (!isPremier) continue;

      if (!isToday(match.gameFinishedAt)) break;

      totalToday++;

      if (match.hasWon) wins++;
      else losses++;

      totalKills += Number(match.ownStats?.kills || match.kills || 0);
      totalDeaths += Number(match.ownStats?.deaths || match.deaths || 0);
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
  } catch (err) {
    console.error(
      "Error detallado en Leetify API:",
      err.response?.status,
      err.response?.data || err.message,
    );
    return {
      nick: PLAYER_NICK || "Jugador",
      elo: "Error API",
      matches_today: 0,
      wins: 0,
      losses: 0,
      winrate: 0,
      kd: "0.00",
    };
  }
}

async function getCachedPremierStats() {
  const now = Date.now();

  if (cachePremier && now - lastFetchPremier < CACHE_TIME) {
    return cachePremier;
  }

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
// CONSTRUCTORES DE MENSAJES Y RUTAS
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

// Endpoints FACEIT
app.get("/elo", async (req, res) => {
  try {
    const stats = await getCachedStats();
    res.send(buildMessage(ELO_MESSAGE_TEMPLATE, stats));
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Error obteniendo elo");
  }
});

app.get("/stats", async (req, res) => {
  try {
    const stats = await getCachedStats();
    res.json(stats);
  } catch {
    res.status(500).json({ error: "Error obteniendo stats" });
  }
});

// Endpoints PREMIER
app.get("/premier", async (req, res) => {
  try {
    const stats = await getCachedPremierStats();
    res.send(buildMessage(PREMIER_MESSAGE_TEMPLATE, stats));
  } catch (err) {
    console.error("Error en Premier:", err.message);
    res.status(500).send("Error obteniendo datos de Premier");
  }
});

app.get("/premier-stats", async (req, res) => {
  try {
    const stats = await getCachedPremierStats();
    res.json(stats);
  } catch {
    res.status(500).json({ error: "Error obteniendo stats de Premier" });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("API corriendo en el puerto", process.env.PORT || 3000);
});

const express = require("express");
const axios = require("axios");

const app = express();

// Variables de entorno para FACEIT
const FACEIT_KEY = process.env.FACEIT_KEY;
const PLAYER_NICK = process.env.FACEIT_NICK;
const ELO_MESSAGE_TEMPLATE = process.env.ELO_MESSAGE;

// Variables de entorno para PREMIER (ScraperAPI + CSStats)
const STEAM_ID_64 = process.env.STEAM_ID_64;
const SCRAPER_KEY = process.env.SCRAPER_KEY;
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
          "No se pudieron obtener stats del match:",
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
// LÓGICA PREMIER (CSSTATS + SCRAPERAPI)
// ==========================================
async function getPremierStats() {
  console.log("Fetching PREMIER stats vía ScraperAPI...");

  if (!STEAM_ID_64 || !SCRAPER_KEY) {
    throw new Error("Faltan variables de entorno STEAM_ID_64 o SCRAPER_KEY");
  }

  const targetUrl = encodeURIComponent(
    `https://csstats.gg/player/${STEAM_ID_64}`,
  );
  const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_KEY}&url=${targetUrl}`;

  let html;
  try {
    const response = await axios.get(scraperUrl);
    html = response.data;
  } catch (err) {
    console.error("Error al conectar con ScraperAPI:", err.message);
    throw new Error("No se pudo obtener la información de Premier.");
  }

  // Extraer Nickname
  const nickMatch =
    html.match(/<span id="player-name">([^<]+)<\/span>/i) ||
    html.match(/<title>CS2 Stats - ([^<]+) - CSStats<\/title>/i);
  const personaName = nickMatch ? nickMatch[1].trim() : PLAYER_NICK;

  // Extraer Rating de Premier
  const ratingMatch =
    html.match(/class="ranks-rating">([0-9,]+)<\/div>/i) ||
    html.match(/CS Rating:\s*([0-9,]+)/i);
  const csRating = ratingMatch ? ratingMatch[1].replace(/,/g, "") : "Sin Rango";

  let wins = 0;
  let losses = 0;
  let totalToday = 0;
  let totalKills = 0;
  let totalDeaths = 0;

  const matchRowRegex =
    /<tr class="match-row[^">]*data-timestamp="(\d+)"[\s\S]*?<\/tr>/g;
  let match;

  while ((match = matchRowRegex.exec(html)) !== null) {
    const timestamp = parseInt(match[1]);

    if (!isToday(timestamp)) break;

    const rowHtml = match[0];

    if (
      !rowHtml.includes("Competitive Premier") &&
      !rowHtml.includes("premier")
    )
      continue;

    totalToday++;

    if (rowHtml.includes("match-won") || rowHtml.includes("outcome-win")) {
      wins++;
    } else {
      losses++;
    }

    const kdMatch = rowHtml.match(/(\d+)\s*\/\s*(\d+)/);
    if (kdMatch) {
      totalKills += parseInt(kdMatch[1]);
      totalDeaths += parseInt(kdMatch[2]);
    }
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
// CONSTRUCTOR DE MENSAJES
// ==========================================
function buildMessage(template, stats) {
  return template
    .replaceAll("{nick}", stats.nick || PLAYER_NICK)
    .replaceAll("{elo}", stats.elo)
    .replaceAll("{matches}", stats.matches_today)
    .replaceAll("{wins}", stats.wins)
    .replaceAll("{losses}", stats.losses)
    .replaceAll("{wr}", stats.winrate)
    .replaceAll("{kd}", stats.kd);
}

// ==========================================
// ENDPOINTS
// ==========================================

// Route FACEIT (Texto)
app.get("/elo", async (req, res) => {
  try {
    const stats = await getCachedStats();
    res.send(buildMessage(ELO_MESSAGE_TEMPLATE, stats));
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Error obteniendo elo");
  }
});

// Route FACEIT (JSON)
app.get("/stats", async (req, res) => {
  try {
    const stats = await getCachedStats();
    res.json(stats);
  } catch {
    res.status(500).json({ error: "Error obteniendo stats" });
  }
});

// Route PREMIER (Texto)
app.get("/premier", async (req, res) => {
  try {
    const stats = await getCachedPremierStats();
    res.send(buildMessage(PREMIER_MESSAGE_TEMPLATE, stats));
  } catch (err) {
    console.error("Error en Premier:", err.message);
    res.status(500).send("Error obteniendo datos de Premier");
  }
});

// Route PREMIER (JSON)
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

const express = require("express");
const axios = require("axios");

const app = express();

const FACEIT_KEY = process.env.FACEIT_KEY;
const PLAYER_NICK = process.env.FACEIT_NICK;
const MESSAGE_TEMPLATE = process.env.ELO_MESSAGE;

const CACHE_TIME = 90000;

let cache = null;
let lastFetch = 0;
let fetching = null;

if (!FACEIT_KEY || !PLAYER_NICK) {
    console.error("Faltan variables de entorno");
    process.exit(1);
}

function isToday(timestamp) {
    const matchDate = new Date(timestamp * 1000);
    const now = new Date();

    return (
        matchDate.getUTCFullYear() === now.getUTCFullYear() &&
        matchDate.getUTCMonth() === now.getUTCMonth() &&
        matchDate.getUTCDate() === now.getUTCDate()
    );
}

async function getStats() {

    console.log("Fetching FACEIT stats...");

    const playerRes = await axios.get(
        `https://open.faceit.com/data/v4/players?nickname=${PLAYER_NICK}`,
        {
            headers: { Authorization: `Bearer ${FACEIT_KEY}` }
        }
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

    // Acumuladores de K/D y MVPs
    let totalKills = 0;
    let totalDeaths = 0;
    let totalMvp = 0;

    while (true) {

        const historyRes = await axios.get(
            `https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=${limit}&offset=${offset}`,
            {
                headers: { Authorization: `Bearer ${FACEIT_KEY}` }
            }
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
                if (team.players.some(p => p.player_id === playerId)) {
                    playerFaction = faction;
                    break;
                }
            }

            if (!playerFaction) continue;

            totalToday++;

            if (playerFaction === winner) wins++;
            else losses++;

            // Consultar estadisticas detalladas del match para K/D y MVPs
            try {
                const matchStatsRes = await axios.get(
                    `https://open.faceit.com/data/v4/matches/${match.match_id}/stats`,
                    { headers: { Authorization: `Bearer ${FACEIT_KEY}` } }
                );
                
                const rounds = matchStatsRes.data.rounds;
                if (rounds && rounds.length > 0) {
                    for (const round of rounds) {
                        const playerStatsList = round.teams.flatMap(t => t.players);
                        const pStats = playerStatsList.find(p => p.player_id === playerId);
                        
                        if (pStats && pStats.player_stats) {
                            const stats = pStats.player_stats;
                            totalKills += Number(stats["Kills"] || 0);
                            totalDeaths += Number(stats["Deaths"] || 0);
                            totalMvp += Number(stats["MVPs"] || 0);
                        }
                    }
                }
            } catch (err) {
                console.error("No se pudieron obtener stats del match:", match.match_id);
            }
        }

        if (foundOlderMatch) break;

        offset += limit;
    }

    const total = wins + losses;
    const kdRatio = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : totalKills.toFixed(2);

    return {
        elo,
        matches_today: totalToday,
        wins,
        losses,
        winrate: total ? Math.round((wins / total) * 100) : 0,
        kd: kdRatio,
        mvps: totalMvp
    };
}

async function getCachedStats() {

    const now = Date.now();

    if (cache && (now - lastFetch < CACHE_TIME)) {
        return cache;
    }

    if (!fetching) {
        fetching = getStats()
            .then((stats) => {
                cache = stats;
                lastFetch = Date.now();
                return stats;
            })
            .finally(() => {
                fetching = null;
            });
    }

    return fetching;
}

function buildMessage(stats) {

    return MESSAGE_TEMPLATE
        .replaceAll("{nick}", PLAYER_NICK)
        .replaceAll("{elo}", stats.elo)
        .replaceAll("{matches}", stats.matches_today)
        .replaceAll("{wins}", stats.wins)
        .replaceAll("{losses}", stats.losses)
        .replaceAll("{wr}", stats.winrate)
        .replaceAll("{kd}", stats.kd)
        .replaceAll("{mvps}", stats.mvps);
}

app.get("/elo", async (req, res) => {
    try {
        const stats = await getCachedStats();
        res.send(buildMessage(stats));
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

app.listen(process.env.PORT || 3000, () => {
    console.log("API corriendo");
});
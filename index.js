const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// maxHttpBufferSize default is 1MB — a single phone photo (as base64) blows past
// that and silently kills the socket. Bump it so map uploads actually arrive.
const io = new Server(server, { maxHttpBufferSize: 1e7 });

app.use(express.static('public'));

const players = {};       // socket.id -> live player
const scores = {};
const lastReactionTimes = {};
const feedMaps = {};      // feedIndex -> dataUrl, so late joiners receive loaded photos
const avatars = {};       // socket.id -> painted-avatar dataUrl (the camouflage other players see)
const playerState = {};   // token -> { isDead }; survives a refresh so reconnects restore state
let currentFeed = 0;      // active camera, kept server-side for late joiners
let gamePhase = 'LOBBY';
let seekerSocketId = null; // current socket of the seeker
let seekerToken = null;    // identity-stable seeker (survives reconnects)
let hostSocketId = null;   // only the host may load maps / start / reset
let hostToken = null;
let seekerPokesLeft = 0;
let gameTimer = null;
let timeLeft = 0;
let lastHideTime = 45;
let lastSeekTime = 120;

function broadcastGameState() {
    io.emit('gameState', { phase: gamePhase, timeLeft, seekerSocketId, hostSocketId, pokesLeft: seekerPokesLeft });
}

// Auto-claims host if none is set yet, so the game can never get stuck with no controller.
function isHost(socket) {
    if (!hostSocketId) { hostSocketId = socket.id; hostToken = (players[socket.id] && players[socket.id].token) || socket.id; }
    return socket.id === hostSocketId;
}

function broadcastScores() {
    io.emit('updateScores', Object.values(scores));
}

function tallyScores() {
    const hiders = Object.values(players).filter(p => p.id !== seekerSocketId);
    const seeker = players[seekerSocketId];

    hiders.filter(p => !p.isDead).forEach(p => {
        if (!scores[p.name]) scores[p.name] = { name: p.name, survivals: 0, catches: 0 };
        scores[p.name].survivals += 1;
    });

    if (seeker) {
        const catchCount = hiders.filter(p => p.isDead).length;
        if (!scores[seeker.name]) scores[seeker.name] = { name: seeker.name, survivals: 0, catches: 0 };
        scores[seeker.name].catches += catchCount;
        console.log(`📊 ${seeker.name} caught ${catchCount} hiders.`);
    }

    broadcastScores();
}

function checkReveal() {
    const hiders = Object.values(players).filter(p => p.id !== seekerSocketId);
    if (hiders.length > 0 && hiders.every(p => p.isDead)) {
        gamePhase = 'REVEAL';
        timeLeft = 0;
        clearInterval(gameTimer);
        tallyScores();
        broadcastGameState();
        console.log('🎉 All hiders poked! REVEAL phase.');
    }
}

io.on('connection', (socket) => {
    console.log('🟢 New connection ID:', socket.id);

    socket.emit('gameState', { phase: gamePhase, timeLeft, seekerSocketId, pokesLeft: seekerPokesLeft });
    socket.emit('updateScores', Object.values(scores));

    // Catch a late joiner up to whatever the host already loaded (fixes "NO SIGNAL"
    // for anyone who joins after the photos were uploaded).
    Object.entries(feedMaps).forEach(([feedIndex, dataUrl]) => {
        socket.emit('loadMap', { feedIndex: Number(feedIndex), dataUrl });
    });
    socket.emit('switchFeed', { feedIndex: currentFeed });

    // Replay painted disguises so the seeker / latecomers see existing camouflage.
    Object.entries(avatars).forEach(([id, avatar]) => socket.emit('playerAvatar', { id, avatar }));

    socket.on('joinGame', (playerData) => {
        const token = playerData.token || socket.id;
        const restored = playerState[token] || { isDead: false };
        players[socket.id] = {
            id: socket.id,
            token,
            name: playerData.name,
            x: playerData.x,
            y: playerData.y,
            color: playerData.color,
            pose: playerData.pose,
            isDead: restored.isDead
        };
        playerState[token] = { isDead: restored.isDead };
        // Re-link roles if this is the same person reconnecting after a refresh.
        if (seekerToken === token) seekerSocketId = socket.id;
        if (hostToken === token) hostSocketId = socket.id;
        console.log(`👤 ${playerData.name} joined Taco Stealth!`);
        socket.emit('selfState', { isDead: players[socket.id].isDead });
        io.emit('updatePlayers', players);
        broadcastGameState();
    });

    socket.on('playerUpdate', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].pose = data.pose;
            players[socket.id].color = data.color;
            socket.broadcast.emit('updatePlayers', players);
        }
    });

    // The painted disguise bitmap — sent rarely (after painting / pose change), kept out of the
    // frequent playerUpdate so position broadcasts stay tiny.
    socket.on('avatarUpdate', ({ avatar }) => {
        if (!players[socket.id] || typeof avatar !== 'string') return;
        avatars[socket.id] = avatar;
        socket.broadcast.emit('playerAvatar', { id: socket.id, avatar });
    });

    socket.on('emojiReaction', (data) => {
        const now = Date.now();
        if (lastReactionTimes[socket.id] && now - lastReactionTimes[socket.id] < 2500) return;
        lastReactionTimes[socket.id] = now;
        io.emit('emojiReaction', { emoji: data.emoji, name: data.name });
    });

    socket.on('hostMap', ({ feedIndex, dataUrl }) => {
        if (!isHost(socket)) return;
        feedMaps[feedIndex] = dataUrl;   // remember it for late joiners
        socket.broadcast.emit('loadMap', { feedIndex, dataUrl });
        console.log(`🗺️  Map stored + broadcast on feed ${feedIndex}`);
    });

    socket.on('hostSwitchFeed', ({ feedIndex }) => {
        // Host sets up cameras; during SEEKING the seeker also swaps between them.
        if (socket.id !== hostSocketId && socket.id !== seekerSocketId) return;
        currentFeed = feedIndex;
        socket.broadcast.emit('switchFeed', { feedIndex });
    });

    socket.on('claimHost', (token) => {
        token = token || (players[socket.id] && players[socket.id].token) || socket.id;
        if (!hostSocketId || hostSocketId === socket.id || hostToken === token) {
            hostSocketId = socket.id; hostToken = token;
            socket.emit('hostStatus', { ok: true });
        } else {
            socket.emit('hostStatus', { ok: false, host: (players[hostSocketId] && players[hostSocketId].name) || 'another player' });
        }
        broadcastGameState();
    });

    socket.on('volunteerSeeker', (data) => {
        io.emit('seekerVolunteer', { name: data.name });
        console.log(`🙋 ${data.name} volunteered as seeker`);
    });

    socket.on('resetGame', () => {
        if (!isHost(socket)) return;
        clearInterval(gameTimer);
        gamePhase = 'LOBBY';
        timeLeft = 0;
        seekerSocketId = null;
        seekerToken = null;
        seekerPokesLeft = 0;
        Object.values(players).forEach(p => { p.isDead = false; });
        for (const t in playerState) delete playerState[t];
        io.emit('updatePlayers', players);
        broadcastGameState();
        broadcastScores();
        console.log('🔄 Game reset to LOBBY.');
    });

    socket.on('startGame', (data) => {
        if (!isHost(socket)) return;
        const seeker = players[data.seekerId];   // selected by connection id, not name
        seekerSocketId = seeker ? seeker.id : null;
        seekerToken = seeker ? seeker.token : null;
        seekerPokesLeft = data.pokeCount || 5;
        lastHideTime = data.hideTime || 45;
        lastSeekTime = data.seekTime || 120;

        Object.values(players).forEach(p => { p.isDead = false; });
        for (const t in playerState) delete playerState[t];
        io.emit('updatePlayers', players);

        gamePhase = 'HIDING';
        timeLeft = lastHideTime;
        broadcastGameState();
        console.log(`🙈 HIDING phase! Seeker: ${seeker ? seeker.name : 'NONE'}, Hide: ${lastHideTime}s, Pokes: ${seekerPokesLeft}`);

        clearInterval(gameTimer);
        gameTimer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                clearInterval(gameTimer);
                gamePhase = 'SEEKING';
                timeLeft = lastSeekTime;
                broadcastGameState();
                console.log(`👁️ SEEKING phase! Seek: ${lastSeekTime}s`);

                gameTimer = setInterval(() => {
                    timeLeft--;
                    if (timeLeft <= 0) {
                        clearInterval(gameTimer);
                        gamePhase = 'REVEAL';
                        timeLeft = 0;
                        tallyScores();
                        broadcastGameState();
                        console.log('🎉 REVEAL phase!');
                        return;
                    }
                    broadcastGameState();
                }, 1000);
                return;
            }
            broadcastGameState();
        }, 1000);
    });

    socket.on('pokeAt', ({ x, y }) => {
        if (socket.id !== seekerSocketId || gamePhase !== 'SEEKING' || seekerPokesLeft <= 0) return;
        if (typeof x !== 'number' || typeof y !== 'number') return;
        // Find the nearest live hider whose center is within poke range of the aimed spot.
        const POKE_RADIUS = 55;
        let best = null, bestDist = POKE_RADIUS;
        Object.values(players).forEach(p => {
            if (p.id === seekerSocketId || p.isDead) return;
            const d = Math.hypot(x - (p.x + 37.5), y - (p.y + 37.5));   // 37.5 = playerSize/2
            if (d < bestDist) { bestDist = d; best = p; }
        });
        if (!best) return;   // miss — no poke consumed, so pokes are never wasted
        seekerPokesLeft--;
        best.isDead = true;
        if (best.token) playerState[best.token] = { isDead: true };
        console.log(`💀 ${best.name} got poked! (${seekerPokesLeft} pokes left)`);
        io.emit('updatePlayers', players);
        io.to(best.id).emit('triggerPickleSlide');
        broadcastGameState();
        checkReveal();
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            console.log(`🔴 ${players[socket.id].name} disconnected.`);
            delete players[socket.id];
            io.emit('updatePlayers', players);
            if (gamePhase === 'SEEKING') checkReveal();
        }
        // Free the role's socket but keep the token, so a refresh re-links seamlessly
        // (and if they're gone for good, someone else can claim host).
        if (socket.id === seekerSocketId) seekerSocketId = null;
        if (socket.id === hostSocketId) hostSocketId = null;
        delete lastReactionTimes[socket.id];
        delete avatars[socket.id];
        broadcastGameState();
    });
});

// Hosts (Render, Fly, Koyeb, Railway, etc.) inject the port via env — must honor it.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Taco Stealth running on port ${PORT}`);
});

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
let gamePhase = 'LOBBY';
let seekerSocketId = null; // current socket of the seeker
let seekerToken = null;    // identity-stable seeker (survives reconnects)
let hostSocketId = null;   // only the host may load maps / start / reset
let hostToken = null;
let seekerPokesLeft = 0;
let sceneCount = 3;        // number of rooms/photos in the shared world (host-configurable)
let gameTimer = null;
let revealTimer = null;
let timeLeft = 0;
let lastHideTime = 45;
let lastSeekTime = 120;

function broadcastGameState() {
    io.emit('gameState', { phase: gamePhase, timeLeft, seekerSocketId, hostSocketId, pokesLeft: seekerPokesLeft, sceneCount });
}

// Auto-claims host if none is set yet, so the game can never get stuck with no controller.
function isHost(socket) {
    if (!hostSocketId) { hostSocketId = socket.id; hostToken = (players[socket.id] && players[socket.id].token) || socket.id; }
    return socket.id === hostSocketId;
}

function broadcastScores() {
    io.emit('updateScores', Object.values(scores));
}

// Seeker catches are scored immediately as they happen (see pokeAt). At REVEAL we only
// hand out survival points to the hiders who were never caught.
function tallyScores() {
    const hiders = Object.values(players).filter(p => p.id !== seekerSocketId);
    hiders.filter(p => !p.isDead).forEach(p => {
        if (!scores[p.name]) scores[p.name] = { name: p.name, survivals: 0, catches: 0 };
        scores[p.name].survivals += 1;
    });
    broadcastScores();
}

// REVEAL holds for 15s (with a visible countdown), then the round auto-returns to the lobby.
function enterReveal() {
    clearInterval(gameTimer);
    clearTimeout(revealTimer);
    gamePhase = 'REVEAL';
    tallyScores();
    timeLeft = 15;
    broadcastGameState();
    console.log('🎉 REVEAL phase! Back to lobby in 15s.');
    gameTimer = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) { clearInterval(gameTimer); returnToLobby(); return; }
        broadcastGameState();
    }, 1000);
}

function returnToLobby() {
    clearInterval(gameTimer);
    clearTimeout(revealTimer);
    gamePhase = 'LOBBY';
    timeLeft = 0;
    seekerSocketId = null;
    seekerToken = null;
    seekerPokesLeft = 0;
    Object.values(players).forEach(p => { p.isDead = false; });
    for (const t in playerState) delete playerState[t];
    io.emit('updatePlayers', players);
    broadcastGameState();   // scores persist across rounds
    console.log('🔄 Auto-returned to LOBBY after reveal.');
}

function checkReveal() {
    const hiders = Object.values(players).filter(p => p.id !== seekerSocketId);
    if (hiders.length > 0 && hiders.every(p => p.isDead)) {
        enterReveal();
        console.log('🎉 All hiders poked!');
    }
}

io.on('connection', (socket) => {
    console.log('🟢 New connection ID:', socket.id);

    socket.emit('gameState', { phase: gamePhase, timeLeft, seekerSocketId, hostSocketId, pokesLeft: seekerPokesLeft, sceneCount });
    socket.emit('updateScores', Object.values(scores));

    // Catch a late joiner up to whatever the host already loaded (fixes "NO SIGNAL"
    // for anyone who joins after the photos were uploaded).
    Object.entries(feedMaps).forEach(([feedIndex, dataUrl]) => {
        socket.emit('loadMap', { feedIndex: Number(feedIndex), dataUrl });
    });

    // Replay painted disguises so the seeker / latecomers see existing camouflage.
    Object.entries(avatars).forEach(([id, avatar]) => socket.emit('playerAvatar', { id, avatar }));

    socket.on('joinGame', (playerData) => {
        const token = playerData.token || socket.id;
        const restored = playerState[token] || { isDead: false };
        players[socket.id] = {
            id: socket.id,
            token,
            name: playerData.name,
            // Positions are world coordinates in the shared stacked world (fixed virtual units,
            // SCENE_W=1000 wide), so every device renders the hider at the same spot — and a player
            // has exactly ONE position, so they can never appear in more than one room.
            x: typeof playerData.x === 'number' ? playerData.x : 500,
            y: typeof playerData.y === 'number' ? playerData.y : 279,
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
            if (typeof data.x === 'number') players[socket.id].x = data.x;
            if (typeof data.y === 'number') players[socket.id].y = data.y;
            players[socket.id].pose = data.pose;
            players[socket.id].color = data.color;
            socket.broadcast.emit('updatePlayers', players);
        }
    });

    // Host sets how many rooms/photos exist in the shared world; everyone rebuilds to match.
    socket.on('setSceneCount', (n) => {
        if (!isHost(socket)) return;
        n = Math.max(1, Math.min(6, parseInt(n) || 3));
        sceneCount = n;
        broadcastGameState();
        console.log(`🏠 Rooms set to ${sceneCount}`);
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
        clearTimeout(revealTimer);
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
        clearTimeout(revealTimer);   // cancel any pending reveal->lobby return
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
                        enterReveal();   // tally + 15s countdown + auto-return to lobby
                        return;
                    }
                    broadcastGameState();
                }, 1000);
                return;
            }
            broadcastGameState();
        }, 1000);
    });

    socket.on('pokeAt', ({ targetId }) => {
        if (socket.id !== seekerSocketId || gamePhase !== 'SEEKING') return;
        // The seeker hit-tests locally against where it drew the hider and passes the target id
        // (or null). Poke economy is INVERTED: a correct catch is free + scores a point; only a
        // WRONG poke (nobody there) spends one of the seeker's limited pokes.
        const best = (targetId && players[targetId]) ? players[targetId] : null;
        const validHit = best && best.id !== seekerSocketId && !best.isDead;

        if (validHit) {
            best.isDead = true;
            if (best.token) playerState[best.token] = { isDead: true };
            const seeker = players[seekerSocketId];
            if (seeker) {
                if (!scores[seeker.name]) scores[seeker.name] = { name: seeker.name, survivals: 0, catches: 0 };
                scores[seeker.name].catches += 1;
            }
            console.log(`💀 ${best.name} caught! (free catch, ${seekerPokesLeft} wrong-pokes left)`);
            io.emit('updatePlayers', players);
            io.to(best.id).emit('triggerPickleSlide');
            io.to(seekerSocketId).emit('pokeResult', { hit: true, name: best.name, pokesLeft: seekerPokesLeft });
            broadcastScores();
            broadcastGameState();
            checkReveal();
        } else {
            // Wrong poke. Correct catches are always allowed, but wrong guesses are limited.
            if (seekerPokesLeft <= 0) { io.to(seekerSocketId).emit('pokeResult', { hit: false, pokesLeft: 0, out: true }); return; }
            seekerPokesLeft--;
            console.log(`❌ Seeker poked nothing. (${seekerPokesLeft} wrong-pokes left)`);
            io.to(seekerSocketId).emit('pokeResult', { hit: false, pokesLeft: seekerPokesLeft });
            broadcastGameState();
        }
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

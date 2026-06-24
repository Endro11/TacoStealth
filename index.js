const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const players = {};
const scores = {};
const lastReactionTimes = {};
let gamePhase = 'LOBBY';
let seekerSocketId = null;
let gameTimer = null;
let timeLeft = 0;
let lastHideTime = 45;
let lastSeekTime = 120;

function broadcastGameState() {
    io.emit('gameState', { phase: gamePhase, timeLeft, seekerSocketId });
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

    socket.emit('gameState', { phase: gamePhase, timeLeft, seekerSocketId });
    socket.emit('updateScores', Object.values(scores));

    socket.on('joinGame', (playerData) => {
        players[socket.id] = {
            id: socket.id,
            name: playerData.name,
            x: playerData.x,
            y: playerData.y,
            color: playerData.color,
            pose: playerData.pose,
            isDead: false
        };
        console.log(`👤 ${playerData.name} joined Taco Stealth!`);
        io.emit('updatePlayers', players);
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

    socket.on('emojiReaction', (data) => {
        const now = Date.now();
        if (lastReactionTimes[socket.id] && now - lastReactionTimes[socket.id] < 2500) return;
        lastReactionTimes[socket.id] = now;
        io.emit('emojiReaction', { emoji: data.emoji, name: data.name });
    });

    socket.on('hostMap', ({ feedIndex, dataUrl }) => {
        socket.broadcast.emit('loadMap', { feedIndex, dataUrl });
        console.log(`🗺️  Map broadcast on feed ${feedIndex}`);
    });

    socket.on('hostSwitchFeed', ({ feedIndex }) => {
        socket.broadcast.emit('switchFeed', { feedIndex });
    });

    socket.on('resetGame', () => {
        clearInterval(gameTimer);
        gamePhase = 'LOBBY';
        timeLeft = 0;
        seekerSocketId = null;
        Object.values(players).forEach(p => { p.isDead = false; });
        io.emit('updatePlayers', players);
        broadcastGameState();
        broadcastScores();
        console.log('🔄 Game reset to LOBBY.');
    });

    socket.on('startGame', (data) => {
        const seeker = Object.values(players).find(p => p.name === data.seekerName.toUpperCase());
        seekerSocketId = seeker ? seeker.id : null;
        lastHideTime = data.hideTime || 45;
        lastSeekTime = data.seekTime || 120;

        Object.values(players).forEach(p => { p.isDead = false; });
        io.emit('updatePlayers', players);

        gamePhase = 'HIDING';
        timeLeft = lastHideTime;
        broadcastGameState();
        console.log(`🙈 HIDING phase! Seeker: ${data.seekerName}, Hide: ${lastHideTime}s`);

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

    socket.on('pokePlayer', (targetId) => {
        if (socket.id !== seekerSocketId) return;
        if (players[targetId] && gamePhase === 'SEEKING') {
            players[targetId].isDead = true;
            console.log(`💀 ${players[targetId].name} got poked by seeker!`);
            io.emit('updatePlayers', players);
            io.to(targetId).emit('triggerPickleSlide');
            checkReveal();
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            console.log(`🔴 ${players[socket.id].name} disconnected.`);
            delete players[socket.id];
            io.emit('updatePlayers', players);
            if (gamePhase === 'SEEKING') checkReveal();
        }
        delete lastReactionTimes[socket.id];
    });
});

server.listen(3000, () => {
    console.log('🚀 Taco Stealth Traffic Cop running on port 3000');
});

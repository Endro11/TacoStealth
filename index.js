const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('🟢 A new player connected! ID:', socket.id);

    socket.on('disconnect', () => {
        console.log('🔴 Player disconnected:', socket.id);
    });
});

server.listen(3000, () => {
    console.log('🚀 Server is running and listening on port 3000');
});

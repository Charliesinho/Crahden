const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the "public" directory
app.use(express.static('public'));

const users = {};

// Handle socket connection
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    users[socket.id] = socket.id;

    // io.emit('user joined', socket.id);

    // Notify all users that someone joined
    io.emit('user status', `${socket.id} joined the chat.`);

    io.emit('update users', Object.keys(users));

    // Handle chat messages
    socket.on('chat message', (msg) => {
        io.emit('chat message', { id: socket.id, text: msg });
    });

    // Notify all users when someone disconnects
    socket.on('disconnect', () => {
        io.emit('user status', `${socket.id} left the chat.`);
        delete users[socket.id];
        console.log('User disconnected:', socket.id);
        io.emit('update users', Object.keys(users));
    });
});

// Start the server
const PORT = 5000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});

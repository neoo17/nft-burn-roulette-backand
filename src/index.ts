const express = require('express');
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { config } from 'dotenv';
import { initGameController } from './controllers/gameController';

config();

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

initGameController(io);

const port = parseInt(process.env.PORT || "4000", 10);
server.listen(port, '0.0.0.0', () => {
    console.log(`Backend running on port ${port}`);
});

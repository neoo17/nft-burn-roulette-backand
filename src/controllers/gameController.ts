import { Server, Socket } from "socket.io";

type User = {
    name: string;
    socket: Socket;
    balance: number;
    inGame: boolean;
};

type PendingGame = {
    id: string;
    creatorId: string;
    creatorName: string;
    bet: number;
};

type GameRoom = {
    players: [string, string];
    sockets: [Socket, Socket];
    bet: number;
    currentTurn: number;
    deck: ("safe" | "burn")[];
    opened: (null | number)[];
    status: "playing" | "finished";
    winnerIndex?: number;
    shuffleUsed: [boolean, boolean];
};

const users: Record<string, User> = {};
const pendingGames: PendingGame[] = [];
const rooms: Record<string, GameRoom> = {};

export function initGameController(io: Server) {
    io.on('connection', (socket) => {
        // 1. Логин/инициализация пользователя
        socket.on('login', ({ name }) => {
            users[socket.id] = {
                name,
                socket,
                balance: 1000, // стартовый баланс
                inGame: false,
            };
            socket.emit("balance", { balance: 1000 });
            socket.emit("lobby");
        });

        // 2. Получить баланс
        socket.on("get_balance", () => {
            const user = users[socket.id];
            if (!user) return;
            socket.emit("balance", { balance: user.balance });
        });

        // 3. Получить список игр
        socket.on("list_games", () => {
            socket.emit("pending_games", pendingGames);
        });

        // 4. Создать игру
        socket.on("create_game", ({ bet }) => {
            const user = users[socket.id];
            if (!user || user.inGame) return;
            if (user.balance < bet || bet <= 0) {
                socket.emit("error_msg", { msg: "Недостаточно баланса для ставки!" });
                return;
            }
            const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            pendingGames.push({
                id,
                creatorId: socket.id,
                creatorName: user.name,
                bet,
            });
            // user.inGame = true;  // УБРАТЬ ЭТУ СТРОКУ
            io.emit("pending_games", pendingGames);
        });

        // 5. Присоединиться к игре
        socket.on("join_game", ({ id }) => {
            console.log("join_game", id, "from", socket.id);

            const idx = pendingGames.findIndex(g => g.id === id);
            if (idx === -1) {
                console.log("pendingGame not found");
                socket.emit("error_msg", { msg: "Игра не найдена." });
                return;
            }

            const game = pendingGames[idx];
            const user = users[socket.id];
            const creator = users[game.creatorId];
            if (!user) {
                console.log("user not found");
                return;
            }
            if (!creator) {
                console.log("creator not found");
                return;
            }
            if (user.inGame) {
                console.log("user already in game", socket.id);
                return;
            }
            if (creator.inGame) {
                console.log("creator already in game", game.creatorId);
                return;
            }
            if (user.balance < game.bet) {
                console.log("user insufficient balance");
                socket.emit("error_msg", { msg: "Недостаточно баланса!" });
                return;
            }

            console.log("game starting!", {user: user.name, creator: creator.name});
            // Всё ок — стартуем
            user.balance -= game.bet;
            creator.balance -= game.bet;
            user.inGame = true;
            creator.inGame = true;

            const room = `room_${game.id}`;
            const deck = Array(5).fill("safe") as ("safe" | "burn")[];
            deck.splice(Math.floor(Math.random() * 6), 0, "burn");
            const sockets: [Socket, Socket] = [creator.socket, user.socket];
            const players: [string, string] = [creator.name, user.name];

            const gameRoom: GameRoom = {
                players,
                sockets,
                bet: game.bet,
                currentTurn: Math.floor(Math.random() * 2),
                deck,
                opened: [null, null, null, null, null, null],
                status: "playing",
                shuffleUsed: [false, false]
            };
            rooms[room] = gameRoom;
            sockets[0].join(room);
            sockets[1].join(room);

            pendingGames.splice(idx, 1);
            io.emit("pending_games", pendingGames);

            sockets[0].emit('start_game', {
                room,
                players,
                bet: game.bet,
                sockets: [sockets[0].id, sockets[1].id],
                currentTurnId: sockets[gameRoom.currentTurn].id,
                shuffleUsed: [...gameRoom.shuffleUsed]
            });
            sockets[1].emit('start_game', {
                room,
                players,
                bet: game.bet,
                sockets: [sockets[0].id, sockets[1].id],
                currentTurnId: sockets[gameRoom.currentTurn].id,
                shuffleUsed: [...gameRoom.shuffleUsed]
            });
            console.log("start_game emitted to both players");
        });


        // 6. Игровая механика (make_move, shuffle_deck) --- оставь свою логику!
        socket.on('make_move', ({ room, cardIndex }) => {
            const game = rooms[room];
            if (!game || game.status !== "playing") return;
            if (socket.id !== game.sockets[game.currentTurn].id) return;
            if (game.opened[cardIndex] !== null) return;

            game.opened[cardIndex] = game.currentTurn;

            const isBurn = game.deck[cardIndex] === "burn";

            io.to(room).emit("card_opened", {
                cardIndex,
                by: game.players[game.currentTurn],
                value: isBurn ? "burn" : "safe"
            });

            if (isBurn) {
                game.status = "finished";
                game.winnerIndex = game.currentTurn === 0 ? 1 : 0;
                io.to(room).emit("game_over", {
                    winner: game.players[game.winnerIndex],
                    loser: game.players[game.currentTurn],
                    burnAt: cardIndex
                });

                // Деньги победителю
                const winnerSock = game.sockets[game.winnerIndex];
                const loserSock = game.sockets[game.currentTurn];
                if (users[winnerSock.id]) users[winnerSock.id].balance += game.bet * 2;
                if (users[winnerSock.id]) users[winnerSock.id].inGame = false;
                if (users[loserSock.id]) users[loserSock.id].inGame = false;

                setTimeout(() => {
                    if (users[winnerSock.id]) winnerSock.emit("balance", { balance: users[winnerSock.id].balance });
                    if (users[loserSock.id]) loserSock.emit("balance", { balance: users[loserSock.id].balance });
                    winnerSock.emit("lobby");
                    loserSock.emit("lobby");
                }, 2000);
                return;
            }

            // Ход следующего игрока
            game.currentTurn = game.currentTurn === 0 ? 1 : 0;
            io.to(room).emit("turn", {
                currentTurnId: game.sockets[game.currentTurn].id,
                shuffleUsed: [...game.shuffleUsed]
            });
        });

        socket.on("shuffle_deck", ({ room }) => {
            const game = rooms[room];
            if (!game || game.status !== "playing") return;
            const playerIdx = game.sockets.findIndex(s => s.id === socket.id);
            if (playerIdx !== game.currentTurn) return;
            if (game.shuffleUsed[playerIdx]) return;

            game.shuffleUsed[playerIdx] = true;
            const deck = Array(5).fill("safe") as ("safe" | "burn")[];
            deck.splice(Math.floor(Math.random() * 6), 0, "burn");
            game.deck = deck;
            game.opened = [null, null, null, null, null, null];

            io.to(room).emit("deck_shuffled", {
                by: game.players[playerIdx],
                shuffleUsed: [...game.shuffleUsed]
            });

            io.to(room).emit("turn", {
                currentTurnId: game.sockets[game.currentTurn].id,
                shuffleUsed: [...game.shuffleUsed]
            });
        });

        // 7. События выхода/обновления баланса
        socket.on('get_balance', () => {
            if (users[socket.id]) socket.emit("balance", { balance: users[socket.id].balance });
        });

        socket.on('disconnect', () => {
            if (users[socket.id]) delete users[socket.id];
        });

        socket.on("cancel_pending_game", () => {
            // Найти игру, созданную этим сокетом
            const idx = pendingGames.findIndex(g => g.creatorId === socket.id);
            if (idx !== -1) {
                pendingGames.splice(idx, 1);
                if (users[socket.id]) users[socket.id].inGame = false;
                io.emit("pending_games", pendingGames);
            }
        });
    });
}

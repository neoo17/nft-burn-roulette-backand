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
    rounds: number; // новое поле!
};

type GameRoom = {
    players: [string, string];
    sockets: [Socket, Socket];
    bet: number;
    rounds: number;
    currentRound: number;
    roundWins: [number, number];
    currentTurn: number;
    deck: ("safe" | "burn")[];
    opened: (null | number)[];
    status: "playing" | "finished";
    winnerIndex?: number;
    shuffleUsed: [boolean, boolean];
    matchFinished: boolean;
    revanshOffered?: boolean[];
};

const users: Record<string, User> = {};
const pendingGames: PendingGame[] = [];
const rooms: Record<string, GameRoom> = {};

export function initGameController(io: Server) {
    io.on('connection', (socket) => {
        socket.on('login', ({ name }) => {
            users[socket.id] = {
                name,
                socket,
                balance: 1000,
                inGame: false,
            };
            socket.emit("balance", { balance: 1000 });
            socket.emit("lobby");
        });

        socket.on("get_balance", () => {
            const user = users[socket.id];
            if (!user) return;
            socket.emit("balance", { balance: user.balance });
        });

        socket.on("list_games", () => {
            socket.emit("pending_games", pendingGames);
        });

        // ----------- СОЗДАНИЕ ИГРЫ -----------
        socket.on("create_game", ({ bet, rounds }) => {
            const user = users[socket.id];
            if (!user || user.inGame) return;
            if (user.balance < bet || bet <= 0) {
                socket.emit("error_msg", { msg: "Недостаточно баланса для ставки!" });
                return;
            }
            if (![1, 3, 5, 7, 9].includes(rounds)) {
                socket.emit("error_msg", { msg: "Некорректное количество раундов!" });
                return;
            }
            const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            pendingGames.push({
                id,
                creatorId: socket.id,
                creatorName: user.name,
                bet,
                rounds,
            });
            io.emit("pending_games", pendingGames);
        });

        // ----------- ПРИСОЕДИНЕНИЕ К ИГРЕ -----------
        socket.on("join_game", ({ id }) => {
            const idx = pendingGames.findIndex(g => g.id === id);
            if (idx === -1) {
                socket.emit("error_msg", { msg: "Игра не найдена." });
                return;
            }
            const game = pendingGames[idx];
            const user = users[socket.id];
            const creator = users[game.creatorId];
            if (!user || !creator) return;
            if (user.inGame || creator.inGame) return;
            if (user.balance < game.bet) {
                socket.emit("error_msg", { msg: "Недостаточно баланса!" });
                return;
            }
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
                rounds: game.rounds,
                currentRound: 1,
                roundWins: [0, 0],
                currentTurn: Math.floor(Math.random() * 2),
                deck,
                opened: [null, null, null, null, null, null],
                status: "playing",
                shuffleUsed: [false, false],
                matchFinished: false,
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
                rounds: game.rounds,
                sockets: [sockets[0].id, sockets[1].id],
                currentTurnId: sockets[gameRoom.currentTurn].id,
                shuffleUsed: [...gameRoom.shuffleUsed],
                roundWins: [...gameRoom.roundWins],
                currentRound: 1
            });
            sockets[1].emit('start_game', {
                room,
                players,
                bet: game.bet,
                rounds: game.rounds,
                sockets: [sockets[0].id, sockets[1].id],
                currentTurnId: sockets[gameRoom.currentTurn].id,
                shuffleUsed: [...gameRoom.shuffleUsed],
                roundWins: [...gameRoom.roundWins],
                currentRound: 1
            });
        });

        // ----------- ХОДЫ И РАУНДЫ -----------
        socket.on('make_move', ({ room, cardIndex }) => {
            const game = rooms[room];
            if (!game || game.status !== "playing" || game.matchFinished) return;
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
                const winner = game.currentTurn === 0 ? 1 : 0;
                game.roundWins[winner]++;
                io.to(room).emit("round_over", {
                    round: game.currentRound,
                    winner: game.players[winner],
                    roundWins: [...game.roundWins],
                });

                const maxRounds = game.rounds;
                const winNeed = Math.floor(maxRounds / 2) + 1;
                const a = game.roundWins[0], b = game.roundWins[1];
                if (a === winNeed || b === winNeed || a + b === maxRounds) {
                    game.status = "finished";
                    game.matchFinished = true;
                    game.winnerIndex = a === winNeed ? 0 : 1;
                    io.to(room).emit("game_over", {
                        matchWinner: game.players[game.winnerIndex],
                        roundWins: [...game.roundWins],
                    });
                    const userA = users[game.sockets[0].id];
                    const userB = users[game.sockets[1].id];
                    if (userA && userB && userA.balance >= game.bet * 2 && userB.balance >= game.bet * 2) {
                        io.to(room).emit("revansh_offer", { nextBet: game.bet * 2 });
                    }
                    if (users[game.sockets[game.winnerIndex].id]) users[game.sockets[game.winnerIndex].id].balance += game.bet * 2;
                    if (users[game.sockets[0].id]) users[game.sockets[0].id].inGame = false;
                    if (users[game.sockets[1].id]) users[game.sockets[1].id].inGame = false;
                    setTimeout(() => {
                        if (users[game.sockets[0].id]) game.sockets[0].emit("balance", { balance: users[game.sockets[0].id].balance });
                        if (users[game.sockets[1].id]) game.sockets[1].emit("balance", { balance: users[game.sockets[1].id].balance });
                        game.sockets[0].emit("lobby");
                        game.sockets[1].emit("lobby");
                    }, 2000);
                    return;
                }

                // Фикс: раунд начинает соперник!
                setTimeout(() => {
                    game.currentRound++;
                    game.deck = Array(5).fill("safe") as ("safe" | "burn")[];
                    game.deck.splice(Math.floor(Math.random() * 6), 0, "burn");
                    game.opened = [null, null, null, null, null, null];
                    game.shuffleUsed = [false, false];
                    game.status = "playing";
                    // Меняем currentTurn на соперника, а не рандом!
                    game.currentTurn = game.currentTurn === 0 ? 1 : 0;
                    io.to(room).emit("new_round", {
                        round: game.currentRound,
                        currentTurnId: game.sockets[game.currentTurn].id,
                        roundWins: [...game.roundWins]
                    });
                    // Сразу отправляем turn для активации кнопок на клиенте!
                    io.to(room).emit("turn", {
                        currentTurnId: game.sockets[game.currentTurn].id,
                        shuffleUsed: [...game.shuffleUsed]
                    });
                }, 2000);

                return;
            } else {
                // смена хода
                game.currentTurn = game.currentTurn === 0 ? 1 : 0;
                io.to(room).emit("turn", {
                    currentTurnId: game.sockets[game.currentTurn].id,
                    shuffleUsed: [...game.shuffleUsed]
                });
            }
        });

        socket.on("shuffle_deck", ({ room }) => {
            const game = rooms[room];
            if (!game || game.status !== "playing" || game.matchFinished) return;
            const playerIdx = game.sockets.findIndex(s => s.id === socket.id);
            if (playerIdx !== game.currentTurn) return;
            if (game.shuffleUsed[playerIdx]) return;
            game.shuffleUsed[playerIdx] = true;
            game.deck = Array(5).fill("safe") as ("safe" | "burn")[];
            game.deck.splice(Math.floor(Math.random() * 6), 0, "burn");
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

        socket.on('get_balance', () => {
            if (users[socket.id]) socket.emit("balance", { balance: users[socket.id].balance });
        });

        socket.on('disconnect', () => {
            if (users[socket.id]) delete users[socket.id];
        });

        socket.on("cancel_pending_game", () => {
            const idx = pendingGames.findIndex(g => g.creatorId === socket.id);
            if (idx !== -1) {
                pendingGames.splice(idx, 1);
                if (users[socket.id]) users[socket.id].inGame = false;
                io.emit("pending_games", pendingGames);
            }
        });

        // ----------- РЕВАНШ X2 -----------
        socket.on('accept_revansh', ({ room }) => {
            const game = rooms[room];
            if (!game || !game.matchFinished) return;
            if (!game.revanshOffered) game.revanshOffered = [false, false];
            const idx = game.sockets.findIndex(s => s.id === socket.id);
            if (idx === -1) return;
            game.revanshOffered[idx] = true;
            if (game.revanshOffered[0] && game.revanshOffered[1]) {
                // Оба согласились — новый матч, ставка x2
                const bet = game.bet * 2;
                const rounds = game.rounds;
                const userA = users[game.sockets[0].id];
                const userB = users[game.sockets[1].id];
                if (!userA || !userB) return;
                if (userA.balance < bet || userB.balance < bet) return;
                userA.balance -= bet;
                userB.balance -= bet;
                // сбросить счет
                game.bet = bet;
                game.currentRound = 1;
                game.roundWins = [0, 0];
                game.status = "playing";
                game.matchFinished = false;
                game.revanshOffered = [false, false];
                game.deck = Array(5).fill("safe") as ("safe" | "burn")[];
                game.deck.splice(Math.floor(Math.random() * 6), 0, "burn");
                game.opened = [null, null, null, null, null, null];
                game.shuffleUsed = [false, false];
                game.currentTurn = Math.floor(Math.random() * 2);
                game.sockets[0].emit('start_game', {
                    room,
                    players: game.players,
                    bet,
                    rounds,
                    sockets: [game.sockets[0].id, game.sockets[1].id],
                    currentTurnId: game.sockets[game.currentTurn].id,
                    shuffleUsed: [...game.shuffleUsed],
                    roundWins: [...game.roundWins],
                    currentRound: 1
                });
                game.sockets[1].emit('start_game', {
                    room,
                    players: game.players,
                    bet,
                    rounds,
                    sockets: [game.sockets[0].id, game.sockets[1].id],
                    currentTurnId: game.sockets[game.currentTurn].id,
                    shuffleUsed: [...game.shuffleUsed],
                    roundWins: [...game.roundWins],
                    currentRound: 1
                });
            }
        });
    });
}

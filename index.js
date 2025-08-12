const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Almacén simple de salas
const rooms = {};

// Colores y cartas para el mazo UNO
const COLORS = ["R", "G", "B", "Y"];
const NUMBERS = [...Array(10).keys()]; // 0 a 9
const ACTIONS = ["Skip", "Reverse", "Draw2"];
const WILD_CARDS = ["Wild", "WildDraw4"];

function createDeck() {
  const deck = [];

  // Cartas numéricas (0 una vez, 1-9 dos veces por color)
  COLORS.forEach((color) => {
    deck.push(color + "0");
    for (let n = 1; n <= 9; n++) {
      deck.push(color + n);
      deck.push(color + n);
    }
    // Cartas de acción (2 de cada tipo por color)
    ACTIONS.forEach((action) => {
      deck.push(color + action);
      deck.push(color + action);
    });
  });

  // Cartas comodín (4 de cada)
  WILD_CARDS.forEach((wild) => {
    for (let i = 0; i < 4; i++) {
      deck.push(wild);
    }
  });

  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

io.on("connection", (socket) => {
  console.log(`Jugador conectado: ${socket.id}`);

  socket.on("createRoom", () => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const deck = shuffle(createDeck());
    rooms[roomId] = {
      players: [socket.id],
      deck,
      discardPile: [],
      gameState: null,
    };
    socket.join(roomId);

    socket.emit("roomCreated", roomId);
    io.to(roomId).emit("playerList", {
      roomId,
      players: rooms[roomId].players,
    });
    console.log(`Sala creada: ${roomId}`);
  });

  socket.on("drawCard", ({ roomId }) => {
    console.log(`Jugador ${socket.id} pide tomar carta en sala ${roomId}`);
    const room = rooms[roomId];
    if (!room || !room.gameState) return;

    const gs = room.gameState;
    const currentPlayerId = gs.players[gs.turnIndex];

    if (socket.id !== currentPlayerId) {
      socket.emit("errorMessage", "No es tu turno para tomar carta");
      return;
    }

    // Sacar carta del mazo (deck)
    if (room.deck.length === 0) {
      // Si no hay cartas en el mazo, rebarajar descarte excepto la última
      if (gs.discardPile.length <= 1) {
        socket.emit("errorMessage", "No hay cartas disponibles para tomar");
        return;
      }
      const lastCard = gs.discardPile.pop();
      room.deck = shuffle(gs.discardPile);
      gs.discardPile = [lastCard];
    }

    const drawnCard = room.deck.shift();

    // Añadir carta a la mano del jugador
    gs.hands[socket.id].push(drawnCard);

    // El turno NO avanza cuando se toma carta, depende reglas específicas
    // Emitir estado actualizado
    io.to(roomId).emit("gameStateUpdate", gs);

    // Opcional: enviar evento específico para la carta tomada (para feedback visual)
    socket.emit("cardDrawn", gs.hands[socket.id]);
  });

  socket.on("joinRoom", (roomId) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit("errorMessage", "Sala no existe");
      return;
    }
    if (room.players.length >= 4) {
      socket.emit("errorMessage", "Sala llena");
      return;
    }

    room.players.push(socket.id);
    socket.join(roomId);

    io.to(roomId).emit("playerList", { roomId, players: room.players });

    // Iniciar juego cuando hay 4 jugadores
    if (room.players.length === 4) {
      room.gameState = iniciarJuego(room);
      io.to(roomId).emit("gameStarted", room.gameState);
    }
  });

  socket.on("playCard", ({ roomId, card }) => {
    const room = rooms[roomId];
    if (!room || !room.gameState) return;

    const gs = room.gameState;
    const currentPlayerId = gs.players[gs.turnIndex];

    if (socket.id !== currentPlayerId) {
      socket.emit("errorMessage", "No es tu turno");
      return;
    }

    const playerHand = gs.hands[socket.id];
    const cardIndex = playerHand.indexOf(card);
    if (cardIndex === -1) {
      socket.emit("errorMessage", "No tienes esa carta");
      return;
    }

    // Validación simple de jugada: la carta debe coincidir en color o número/acción o ser comodín
    if (!isValidPlay(card, gs.currentCard)) {
      socket.emit("errorMessage", "Carta no válida para jugar");
      return;
    }

    // Sacar la carta de la mano
    playerHand.splice(cardIndex, 1);

    // Poner la carta en el descarte y actualizar carta actual
    gs.discardPile.push(card);
    gs.currentCard = card;

    // Avanzar el turno (sin lógica de reversa o saltos para simplicidad)
    gs.turnIndex = (gs.turnIndex + 1) % gs.players.length;

    io.to(roomId).emit("gameStateUpdate", gs);
  });

  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const idx = room.players.indexOf(socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        io.to(roomId).emit("playerList", { roomId, players: room.players });

        // Si sala vacía, eliminarla
        if (room.players.length === 0) {
          delete rooms[roomId];
        }
        break;
      }
    }
  });
});

// backend: game logic
function iniciarJuego(room) {
  const { players, deck } = room;

  // Repartir 7 cartas por jugador
  const hands = {};
  players.forEach((p) => {
    hands[p] = deck.splice(0, 7);
  });

  // Sacar carta inicial que no sea comodín ni +4
  let firstCard;
  do {
    firstCard = deck.shift();
    if (WILD_CARDS.includes(firstCard) || firstCard.includes("Draw4")) {
      deck.push(firstCard); // mover al final
    } else {
      break;
    }
  } while (deck.length > 0);

  room.deck = deck;

  return {
    players,
    hands,
    discardPile: [firstCard],
    currentCard: firstCard, // aquí se asegura que nunca sea null
    turnIndex: 0,
  };
}

// Validación simple de jugada
function isValidPlay(cardToPlay, currentCard) {
  // Si es comodín siempre válido
  if (WILD_CARDS.includes(cardToPlay)) return true;

  // Si la carta actual es comodín, cualquier carta es válida (simplificación)
  if (WILD_CARDS.includes(currentCard)) return true;

  // Coincidir color o valor/acción (extraer color y valor)
  const cardColor = cardToPlay[0];
  const cardValue = cardToPlay.slice(1);
  const currentColor = currentCard[0];
  const currentValue = currentCard.slice(1);

  return cardColor === currentColor || cardValue === currentValue;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor escuchando en puerto 3000");
});

import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "crypto";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = "0.0.0.0";

type Client = {
  id: string;
  socket: WebSocket;
  roomId: string | null;
};

const clients = new Map<WebSocket, Client>();
const rooms = new Map<string, Set<WebSocket>>();
const MAX_ROOM_SIZE = 5;

const wss = new WebSocketServer({
  port: PORT,
  host: HOST,
});

function generateRoomId(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

function send(socket: WebSocket, message: object) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function getClientById(id: string, room: Set<WebSocket>) {
  for (const socket of room) {
    if (clients.get(socket)?.id === id) return socket;
  }
  return undefined;
}

function leaveRoom(socket: WebSocket) {
  const client = clients.get(socket);

  if (!client?.roomId) {
    return;
  }

  const room = rooms.get(client.roomId);

  if (room) {
    room.delete(socket);

    for (const peer of room) {
      send(peer, {
        type: "peer-left",
        peerId: client.id,
      });
    }

    if (room.size === 0) {
      rooms.delete(client.roomId);
    }
  }

  client.roomId = null;
}

function joinRoom(socket: WebSocket, roomId: string) {
  const normalizedRoomId = roomId.trim().toUpperCase();

  if (
    !normalizedRoomId ||
    normalizedRoomId.length > 20
  ) {
    send(socket, {
      type: "error",
      message: "Invalid room ID",
    });

    return;
  }

  leaveRoom(socket);

  let room = rooms.get(normalizedRoomId);

  if (!room) {
    room = new Set();
    rooms.set(normalizedRoomId, room);
  }

  if (room.size >= MAX_ROOM_SIZE) {
    send(socket, {
      type: "error",
      message: "Room is full",
    });

    return;
  }

  room.add(socket);

  const client = clients.get(socket);

  if (client) {
    client.roomId = normalizedRoomId;
  }

  send(socket, {
    type: "room-joined",
    roomId: normalizedRoomId,
    peers: room.size - 1,
    peerIds: [...room]
      .filter((peer) => peer !== socket)
      .map((peer) => clients.get(peer)?.id)
      .filter(Boolean),
  });

  for (const peer of room) {
    if (peer !== socket) {
      const client = clients.get(socket);
      send(peer, {
        type: "peer-joined",
        peerId: client?.id,
      });
    }
  }
}

wss.on("connection", (socket) => {
  clients.set(socket, {
    id: randomBytes(8).toString("hex"),
    socket,
    roomId: null,
  });

  send(socket, {
    type: "connected",
  });

  socket.on("message", (rawMessage) => {
    try {
      const message = JSON.parse(
        rawMessage.toString(),
      );

      if (message.type === "create-room") {
        const roomId = generateRoomId();

        joinRoom(socket, roomId);

        return;
      }

      if (message.type === "join-room") {
        joinRoom(socket, message.roomId);

        return;
      }

      if (
        message.type === "offer" ||
        message.type === "answer" ||
        message.type === "ice-candidate"
      ) {
        const client = clients.get(socket);

        if (!client?.roomId) {
          send(socket, {
            type: "error",
            message: "You are not in a room",
          });

          return;
        }

        const room = rooms.get(client.roomId);

        if (!room) {
          return;
        }

        const sender = clients.get(socket);
        const target = typeof message.to === "string"
          ? getClientById(message.to, room)
          : undefined;

        if (!sender || !target || target === socket) {
          send(socket, { type: "error", message: "Peer target was not found" });
          return;
        }

        send(target, { ...message, from: sender.id });

        return;
      }

      send(socket, {
        type: "error",
        message: "Unknown message type",
      });
    } catch {
      send(socket, {
        type: "error",
        message: "Invalid message",
      });
    }
  });

  socket.on("close", () => {
    leaveRoom(socket);
    clients.delete(socket);
  });

  socket.on("error", () => {
    leaveRoom(socket);
    clients.delete(socket);
  });
});

wss.on("listening", () => {
  console.log(
    `PeerShare signaling server running on ws://${HOST}:${PORT}`,
  );
});

wss.on("error", (error) => {
  console.error(
    "WebSocket server error:",
    error,
  );
});
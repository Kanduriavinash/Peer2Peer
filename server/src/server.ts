import { WebSocketServer, WebSocket } from "ws";
import { randomBytes } from "crypto";

const PORT = 8080;

type Client = {
  socket: WebSocket;
  roomId: string | null;
};

const clients = new Map<WebSocket, Client>();
const rooms = new Map<string, Set<WebSocket>>();

const wss = new WebSocketServer({
  port: PORT,
});

function generateRoomId(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

function send(socket: WebSocket, message: object) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
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

  if (!normalizedRoomId || normalizedRoomId.length > 20) {
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

  if (room.size >= 2) {
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
  });

  for (const peer of room) {
    if (peer !== socket) {
      send(peer, {
        type: "peer-joined",
      });
    }
  }
}

wss.on("connection", (socket) => {
  clients.set(socket, {
    socket,
    roomId: null,
  });

  send(socket, {
    type: "connected",
  });

  socket.on("message", (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString());

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

        for (const peer of room) {
          if (peer !== socket) {
            send(peer, message);
          }
        }

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

console.log(`PeerShare signaling server running on ws://localhost:${PORT}`);
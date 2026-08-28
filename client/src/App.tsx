import { useEffect, useRef, useState } from "react";
import "./App.css";

type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected";

type PeerState =
  | "waiting"
  | "connecting"
  | "connected"
  | "disconnected";

type TransferState =
  | "idle"
  | "sending"
  | "receiving"
  | "complete"
  | "error";

type FileMetadata = {
  name: string;
  size: number;
  type: string;
};

const CHUNK_SIZE = 16 * 1024;

function App() {
  const socketRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  const receivedChunksRef = useRef<Blob[]>([]);
  const receivedSizeRef = useRef(0);
  const receivedMetadataRef = useRef<FileMetadata | null>(null);

  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");

  const [peerState, setPeerState] =
    useState<PeerState>("waiting");

  const [roomId, setRoomId] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [isInRoom, setIsInRoom] = useState(false);
  const [error, setError] = useState("");

  const [selectedFile, setSelectedFile] =
    useState<File | null>(null);

  const [transferState, setTransferState] =
    useState<TransferState>("idle");

  const [transferProgress, setTransferProgress] =
    useState(0);

  const [transferStatus, setTransferStatus] =
    useState("");

  const [downloadUrl, setDownloadUrl] =
    useState<string | null>(null);

  const sendSignal = (message: object) => {
    const socket = socketRef.current;

    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  const createPeerConnection = () => {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const peerConnection = new RTCPeerConnection({
      iceServers: [
        {
          urls: "stun:stun.l.google.com:19302",
        },
      ],
    });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({
          type: "ice-candidate",
          candidate: event.candidate,
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;

      console.log("WebRTC:", state);

      if (state === "connecting") {
        setPeerState("connecting");
      }

      if (state === "connected") {
        setPeerState("connected");
      }

      if (
        state === "disconnected" ||
        state === "failed" ||
        state === "closed"
      ) {
        setPeerState("disconnected");
      }
    };

    peerConnectionRef.current = peerConnection;

    return peerConnection;
  };

  const setupDataChannel = (channel: RTCDataChannel) => {
    dataChannelRef.current = channel;

    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      console.log("Data channel opened");
      setPeerState("connected");
    };

    channel.onclose = () => {
      console.log("Data channel closed");
    };

    channel.onerror = (event) => {
      console.error("Data channel error:", event);
      setTransferState("error");
      setTransferStatus("Transfer failed.");
    };

    channel.onmessage = (event) => {
      const data = event.data;

      if (typeof data === "string") {
        try {
          const message = JSON.parse(data);

          if (message.type === "file-metadata") {
            const metadata: FileMetadata = {
              name: message.name,
              size: message.size,
              type: message.mimeType || "application/octet-stream",
            };

            receivedMetadataRef.current = metadata;
            receivedChunksRef.current = [];
            receivedSizeRef.current = 0;

            setTransferState("receiving");
            setTransferProgress(0);
            setTransferStatus(`Receiving ${metadata.name}...`);
          }

          if (message.type === "file-complete") {
            const metadata = receivedMetadataRef.current;

            if (!metadata) {
              return;
            }

            const blob = new Blob(
              receivedChunksRef.current,
              {
                type: metadata.type,
              },
            );

            const url = URL.createObjectURL(blob);

            setDownloadUrl(url);
            setTransferProgress(100);
            setTransferState("complete");
            setTransferStatus("File received successfully.");

            receivedChunksRef.current = [];
            receivedSizeRef.current = 0;
          }

          if (message.type === "transfer-error") {
            setTransferState("error");
            setTransferStatus(
              message.message || "Transfer failed.",
            );
          }
        } catch {
          console.error("Invalid data channel message.");
        }

        return;
      }

      const chunk = new Blob([data]);

      receivedChunksRef.current.push(chunk);
      receivedSizeRef.current += chunk.size;

      const metadata = receivedMetadataRef.current;

      if (metadata) {
        const progress =
          (receivedSizeRef.current / metadata.size) * 100;

        setTransferProgress(
          Math.min(100, Math.round(progress)),
        );

        setTransferStatus(
          `Receiving ${metadata.name}... ${Math.round(
            progress,
          )}%`,
        );
      }
    };
  };

  const createOffer = async () => {
    try {
      const peerConnection = createPeerConnection();

      const channel =
        peerConnection.createDataChannel(
          "file-transfer",
        );

      setupDataChannel(channel);

      const offer =
        await peerConnection.createOffer();

      await peerConnection.setLocalDescription(
        offer,
      );

      sendSignal({
        type: "offer",
        offer,
      });

      setPeerState("connecting");
    } catch (err) {
      console.error("Offer error:", err);
      setError(
        "Could not establish the peer connection.",
      );
    }
  };

  useEffect(() => {
    const socket = new WebSocket(
      "ws://localhost:8080",
    );

    socketRef.current = socket;

    setConnectionState("connecting");

    socket.onopen = () => {
      console.log(
        "Connected to signaling server",
      );

      setConnectionState("connected");
      setError("");
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);

        switch (message.type) {
          case "connected":
            break;

          case "room-joined":
            setRoomId(message.roomId);
            setIsInRoom(true);

            if (message.peers > 0) {
              setPeerState("connecting");
            }

            break;

          case "peer-joined":
            setPeerState("connecting");
            await createOffer();
            break;

          case "offer": {
            const peerConnection =
              createPeerConnection();

            peerConnection.ondatachannel = (
              event,
            ) => {
              setupDataChannel(event.channel);
            };

            await peerConnection.setRemoteDescription(
              new RTCSessionDescription(
                message.offer,
              ),
            );

            const answer =
              await peerConnection.createAnswer();

            await peerConnection.setLocalDescription(
              answer,
            );

            sendSignal({
              type: "answer",
              answer,
            });

            setPeerState("connecting");

            break;
          }

          case "answer": {
            const peerConnection =
              peerConnectionRef.current;

            if (!peerConnection) {
              return;
            }

            await peerConnection.setRemoteDescription(
              new RTCSessionDescription(
                message.answer,
              ),
            );

            break;
          }

          case "ice-candidate": {
            const peerConnection =
              createPeerConnection();

            if (message.candidate) {
              try {
                await peerConnection.addIceCandidate(
                  new RTCIceCandidate(
                    message.candidate,
                  ),
                );
              } catch (err) {
                console.error(
                  "ICE candidate error:",
                  err,
                );
              }
            }

            break;
          }

          case "peer-left":
            setPeerState("disconnected");

            dataChannelRef.current?.close();
            peerConnectionRef.current?.close();

            dataChannelRef.current = null;
            peerConnectionRef.current = null;

            break;

          case "error":
            setError(message.message);
            break;

          default:
            console.log(
              "Unknown server message:",
              message,
            );
        }
      } catch (err) {
        console.error(
          "Signaling message error:",
          err,
        );
      }
    };

    socket.onerror = () => {
      setConnectionState("disconnected");

      setError(
        "Unable to connect to the PeerShare server.",
      );
    };

    socket.onclose = () => {
      setConnectionState("disconnected");
      setPeerState("disconnected");
    };

    return () => {
      dataChannelRef.current?.close();
      peerConnectionRef.current?.close();
      socket.close();

      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
      }
    };
  }, []);

  const createRoom = () => {
    setError("");

    if (
      socketRef.current?.readyState !==
      WebSocket.OPEN
    ) {
      setError(
        "Server connection is not ready.",
      );

      return;
    }

    socketRef.current.send(
      JSON.stringify({
        type: "create-room",
      }),
    );
  };

  const joinRoom = () => {
    const code = joinCode.trim().toUpperCase();

    if (!code) {
      setError("Enter a room code.");
      return;
    }

    if (
      socketRef.current?.readyState !==
      WebSocket.OPEN
    ) {
      setError(
        "Server connection is not ready.",
      );

      return;
    }

    setError("");

    socketRef.current.send(
      JSON.stringify({
        type: "join-room",
        roomId: code,
      }),
    );
  };

  const handleFileChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setSelectedFile(file);
    setTransferState("idle");
    setTransferProgress(0);
    setTransferStatus("");
    setDownloadUrl(null);
  };

  const sendFile = async () => {
    const file = selectedFile;
    const channel = dataChannelRef.current;

    if (!file) {
      setError("Choose a file first.");
      return;
    }

    if (!channel) {
      setError("P2P connection is not ready.");
      return;
    }

    if (channel.readyState !== "open") {
      setError("P2P data channel is not open.");
      return;
    }

    try {
      setError("");
      setTransferState("sending");
      setTransferProgress(0);
      setTransferStatus(
        `Preparing ${file.name}...`,
      );

      channel.send(
        JSON.stringify({
          type: "file-metadata",
          name: file.name,
          size: file.size,
          mimeType:
            file.type ||
            "application/octet-stream",
        }),
      );

      let offset = 0;

      while (offset < file.size) {
        if (channel.readyState !== "open") {
          throw new Error(
            "Connection closed during transfer.",
          );
        }

        const chunk = await file
          .slice(
            offset,
            offset + CHUNK_SIZE,
          )
          .arrayBuffer();

        channel.send(chunk);

        offset += chunk.byteLength;

        const progress =
          (offset / file.size) * 100;

        setTransferProgress(
          Math.min(100, Math.round(progress)),
        );

        setTransferStatus(
          `Sending ${file.name}... ${Math.round(
            progress,
          )}%`,
        );

        if (channel.bufferedAmount > 4 * 1024 * 1024) {
          await new Promise<void>((resolve) => {
            const checkBuffer = () => {
              if (
                channel.bufferedAmount <=
                1024 * 1024
              ) {
                channel.removeEventListener(
                  "bufferedamountlow",
                  checkBuffer,
                );

                resolve();
              }
            };

            channel.bufferedAmountLowThreshold =
              1024 * 1024;

            channel.addEventListener(
              "bufferedamountlow",
              checkBuffer,
            );

            checkBuffer();
          });
        }
      }

      channel.send(
        JSON.stringify({
          type: "file-complete",
        }),
      );

      setTransferProgress(100);
      setTransferState("complete");
      setTransferStatus(
        "File sent successfully.",
      );
    } catch (err) {
      console.error(
        "File transfer error:",
        err,
      );

      channel.send(
        JSON.stringify({
          type: "transfer-error",
          message: "Sender stopped the transfer.",
        }),
      );

      setTransferState("error");
      setTransferStatus(
        "File transfer failed.",
      );
    }
  };

  const copyRoomCode = async () => {
    if (!roomId) {
      return;
    }

    await navigator.clipboard.writeText(
      roomId,
    );

    setTransferStatus(
      "Room code copied!",
    );
  };

  const resetRoom = () => {
    window.location.reload();
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(
        bytes / 1024
      ).toFixed(1)} KB`;
    }

    if (bytes < 1024 * 1024 * 1024) {
      return `${(
        bytes /
        1024 /
        1024
      ).toFixed(2)} MB`;
    }

    return `${(
      bytes /
      1024 /
      1024 /
      1024
    ).toFixed(2)} GB`;
  };

  return (
    <div className="app">
      <nav className="navbar">
        <div className="brand">
          <div className="brand-icon">
            P
          </div>

          <span>PeerShare</span>
        </div>

        <div className="nav-status">
          <span
            className={`status-dot ${
              connectionState !==
              "connected"
                ? "offline"
                : ""
            }`}
          />

          {connectionState ===
          "connected"
            ? "Server online"
            : connectionState ===
                "connecting"
              ? "Connecting..."
              : "Server offline"}
        </div>
      </nav>

      <main className="hero">
        <section className="hero-content">
          <div className="badge">
            <span>⚡</span>
            Direct peer-to-peer sharing
          </div>

          <h1>
            Share files.
            <br />
            <span>Directly.</span>
          </h1>

          <p className="subtitle">
            Send photos, videos, documents,
            and large files directly between
            devices.
          </p>

          {!isInRoom ? (
            <div className="room-card">
              <div className="room-section">
                <div className="room-icon">
                  ↗
                </div>

                <h2>
                  Create a transfer
                </h2>

                <p>
                  Start a private room and
                  invite another device.
                </p>

                <button
                  className="primary-button"
                  onClick={createRoom}
                  disabled={
                    connectionState !==
                    "connected"
                  }
                >
                  Create Transfer
                </button>
              </div>

              <div className="divider">
                <span>OR</span>
              </div>

              <div className="room-section">
                <div className="room-icon">
                  ↙
                </div>

                <h2>
                  Join a transfer
                </h2>

                <p>
                  Enter the room code shared
                  by the sender.
                </p>

                <div className="join-form">
                  <input
                    type="text"
                    placeholder="Enter room code"
                    value={joinCode}
                    onChange={(event) =>
                      setJoinCode(
                        event.target.value.toUpperCase(),
                      )
                    }
                    maxLength={20}
                  />

                  <button
                    className="secondary-button"
                    onClick={joinRoom}
                    disabled={
                      connectionState !==
                      "connected"
                    }
                  >
                    Join
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="room-card active-room">
              <div className="room-icon">
                ✓
              </div>

              <p className="room-label">
                TRANSFER ROOM
              </p>

              <div className="room-code">
                {roomId}
              </div>

              <p className="room-description">
                Share this code with the
                other device.
              </p>

              <div className="room-actions">
                <button
                  className="primary-button"
                  onClick={copyRoomCode}
                >
                  Copy Room Code
                </button>

                <button
                  className="secondary-button"
                  onClick={resetRoom}
                >
                  Leave
                </button>
              </div>

              <div
                className={`peer-status ${
                  peerState ===
                  "connected"
                    ? "peer-online"
                    : ""
                }`}
              >
                <span className="peer-dot" />

                {peerState ===
                "connected"
                  ? "P2P connection established"
                  : peerState ===
                      "connecting"
                    ? "Establishing P2P connection..."
                    : peerState ===
                        "disconnected"
                      ? "Peer disconnected"
                      : "Waiting for another device..."}
              </div>

              {peerState ===
                "connected" && (
                <div className="file-transfer">
                  <label className="file-picker">
                    <input
                      type="file"
                      onChange={
                        handleFileChange
                      }
                    />

                    <span className="file-picker-icon">
                      +
                    </span>

                    <span>
                      {selectedFile
                        ? "Change file"
                        : "Choose file"}
                    </span>
                  </label>

                  {selectedFile && (
                    <div className="selected-file">
                      <div>
                        <strong>
                          {selectedFile.name}
                        </strong>

                        <span>
                          {formatFileSize(
                            selectedFile.size,
                          )}
                        </span>
                      </div>

                      <button
                        className="primary-button send-button"
                        onClick={sendFile}
                        disabled={
                          transferState ===
                          "sending"
                        }
                      >
                        {transferState ===
                        "sending"
                          ? "Sending..."
                          : "Send File"}
                      </button>
                    </div>
                  )}

                  {transferState !==
                    "idle" && (
                    <div className="transfer-progress">
                      <div className="progress-header">
                        <span>
                          {transferStatus}
                        </span>

                        <strong>
                          {
                            transferProgress
                          }
                          %
                        </strong>
                      </div>

                      <div className="progress-track">
                        <div
                          className="progress-bar"
                          style={{
                            width: `${transferProgress}%`,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {downloadUrl && (
                    <a
                      className="download-button"
                      href={downloadUrl}
                      download={
                        receivedMetadataRef
                          .current?.name ||
                        "download"
                      }
                    >
                      ↓ Download received file
                    </a>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="error-message">
              {error}
            </div>
          )}

          <div className="how-it-works">
            <h3>
              How PeerShare works
            </h3>

            <div className="steps">
              <div className="step">
                <div className="step-number">
                  01
                </div>

                <div>
                  <strong>
                    Create or join
                  </strong>

                  <p>
                    Start a transfer room
                    with a simple code.
                  </p>
                </div>
              </div>

              <div className="step">
                <div className="step-number">
                  02
                </div>

                <div>
                  <strong>
                    Connect a peer
                  </strong>

                  <p>
                    WebRTC creates a direct
                    browser connection.
                  </p>
                </div>
              </div>

              <div className="step">
                <div className="step-number">
                  03
                </div>

                <div>
                  <strong>
                    Transfer directly
                  </strong>

                  <p>
                    File chunks travel through
                    the WebRTC data channel.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <span>PeerShare</span>
        <span>
          Private. Fast. Peer-to-peer.
        </span>
      </footer>
    </div>
  );
}

export default App;
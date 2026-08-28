import { useEffect, useRef, useState } from "react";
import { sha256 } from "js-sha256";
import { get, onChildAdded, onDisconnect, onValue, push, ref, remove, set } from "firebase/database";
import { signInAnonymously } from "firebase/auth";
import { auth, database } from "./firebase";
import "./App.css";

type Metadata = { name: string; size: number; type: string; hash: string };
type Incoming = { transferId: string; metadata: Metadata; chunks: Blob[]; size: number };
type Peer = { pc: RTCPeerConnection; channel?: RTCDataChannel; candidates: RTCIceCandidateInit[]; offerStarted: boolean };

const MAX_MEMBERS = 5;
const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED = 4 * 1024 * 1024;
const LOW_BUFFERED = 1024 * 1024;

const hashFile = async (file: Blob) => sha256(await file.arrayBuffer());
const createId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(2)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

function App() {
  const clientIdRef = useRef(createId());
  const roomRef = useRef("");
  const peersRef = useRef(new Map<string, Peer>());
  const incomingRef = useRef(new Map<string, Incoming>());
  const [serverStatus, setServerStatus] = useState("connecting");
  const [roomId, setRoomId] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [inRoom, setInRoom] = useState(false);
  const [memberCount, setMemberCount] = useState(1);
  const [connectedCount, setConnectedCount] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [downloads, setDownloads] = useState<{ url: string; name: string }[]>([]);

  const signal = (to: string, message: object) => {
    const room = roomRef.current;
    if (!room) return;
    void push(ref(database, `rooms/${room}/signals/${to}`), { ...message, from: clientIdRef.current })
      .catch((signalError: unknown) => {
        const code = signalError instanceof Error && "code" in signalError ? String(signalError.code) : "unknown-error";
        setError(`Firebase signaling failed (${code}). Check that Realtime Database rules are published.`);
      });
  };

  const refreshConnected = () => setConnectedCount([...peersRef.current.values()].filter((peer) => peer.channel?.readyState === "open").length);

  const setupChannel = (peerId: string, channel: RTCDataChannel) => {
    const peer = peersRef.current.get(peerId);
    if (!peer) return;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_BUFFERED;
    peer.channel = channel;
    channel.onopen = () => {
      setError("");
      refreshConnected();
    };
    channel.onclose = refreshConnected;
    channel.onerror = () => setError(`Connection to one member failed. Other members can still transfer.`);
    channel.onmessage = async (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as { type: string; transferId?: string; metadata?: Metadata; message?: string };
        if (message.type === "file-start" && message.transferId && message.metadata) {
          incomingRef.current.set(peerId, { transferId: message.transferId, metadata: message.metadata, chunks: [], size: 0 });
          setProgress(0);
          setStatus(`Receiving ${message.metadata.name}...`);
        } else if (message.type === "file-complete" && message.transferId) {
          const incoming = incomingRef.current.get(peerId);
          if (!incoming) return;
          const blob = new Blob(incoming.chunks, { type: incoming.metadata.type });
          if (await hashFile(blob) !== incoming.metadata.hash) {
            setError(`Verification failed for ${incoming.metadata.name}.`);
            setStatus("Transfer failed");
          } else {
            setDownloads((current) => [...current, { url: URL.createObjectURL(blob), name: incoming.metadata.name }]);
            setProgress(100);
            setStatus(`${incoming.metadata.name} received and verified ✓`);
          }
          incomingRef.current.delete(peerId);
        } else if (message.type === "transfer-error") {
          setError(message.message ?? "Transfer failed.");
          setStatus("Transfer failed");
        }
        return;
      }
      const incoming = incomingRef.current.get(peerId);
      if (!incoming) return;
      const chunk = new Blob([event.data]);
      incoming.chunks.push(chunk);
      incoming.size += chunk.size;
      const nextProgress = Math.round((incoming.size / incoming.metadata.size) * 100);
      setProgress(Math.min(100, nextProgress));
      setStatus(`Receiving ${incoming.metadata.name}... ${nextProgress}%`);
    };
  };

  const createPeer = (peerId: string) => {
    const existing = peersRef.current.get(peerId);
    if (existing) return existing;
    const peer: Peer = { pc: new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }), candidates: [], offerStarted: false };
    peer.pc.onicecandidate = (event) => event.candidate && signal(peerId, { type: "ice-candidate", candidate: event.candidate });
    peer.pc.onconnectionstatechange = () => {
      refreshConnected();
      if (peer.pc.connectionState === "failed") setError("A direct connection failed. Try again on a different network or configure TURN.");
    };
    peer.pc.ondatachannel = (event) => setupChannel(peerId, event.channel);
    peersRef.current.set(peerId, peer);
    return peer;
  };

  const makeOffer = async (peerId: string) => {
    try {
      const peer = createPeer(peerId);
      if (peer.offerStarted || peer.pc.signalingState !== "stable") return;
      peer.offerStarted = true;
      setupChannel(peerId, peer.pc.createDataChannel("file-transfer"));
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      signal(peerId, { type: "offer", offer });
    } catch (offerError) {
      setError(`Could not connect to a member: ${offerError instanceof Error ? offerError.message : "WebRTC offer failed"}`);
    }
  };

  const removePeer = (peerId: string) => {
    const peer = peersRef.current.get(peerId);
    peer?.channel?.close();
    peer?.pc.close();
    peersRef.current.delete(peerId);
    refreshConnected();
  };

  const joinFirebaseRoom = async (code: string) => {
    const membersSnapshot = await get(ref(database, `rooms/${code}/members`));
    const members = membersSnapshot.val() ?? {};
    const existingIds = Object.keys(members).filter((id) => members[id] === true && id !== clientIdRef.current);
    if (existingIds.length >= MAX_MEMBERS) throw new Error("Room is full (maximum 5 members).");
    roomRef.current = code;
    await set(ref(database, `rooms/${code}/members/${clientIdRef.current}`), true);
    await onDisconnect(ref(database, `rooms/${code}/members/${clientIdRef.current}`)).remove();
    setRoomId(code); setInRoom(true); setMemberCount(existingIds.length + 1); setServerStatus("online");
    onValue(ref(database, `rooms/${code}/members`), (snapshot) => {
      const activeIds = new Set<string>();
      snapshot.forEach((child) => {
        if (child.val() === true) activeIds.add(child.key ?? "");
        return false;
      });
      for (const peerId of peersRef.current.keys()) {
        if (!activeIds.has(peerId)) removePeer(peerId);
      }
      const count = activeIds.size;
      setMemberCount(count);
      // Use a deterministic initiator for every pair. This prevents offer
      // collisions and does not depend on join timing or browser speed.
      for (const peerId of activeIds) {
        const peer = peersRef.current.get(peerId);
        if (peerId !== clientIdRef.current && clientIdRef.current < peerId && !peer?.offerStarted) {
          void makeOffer(peerId);
        }
      }
    });
  };

  useEffect(() => {
    signInAnonymously(auth)
      .then(() => setServerStatus("online"))
      .catch((authError: unknown) => {
        const code = authError instanceof Error && "code" in authError
          ? String(authError.code)
          : "unknown-error";
        setServerStatus("offline");
        setError(`Firebase sign-in failed (${code}). Check Anonymous sign-in and Authorized domains.`);
      });
    return () => { peersRef.current.forEach((peer) => peer.pc.close()); };
  }, []);

  useEffect(() => {
    if (!roomRef.current) return;
    const signalPath = ref(database, `rooms/${roomRef.current}/signals/${clientIdRef.current}`);
    return onChildAdded(signalPath, (child) => {
      const message = child.val() as { type: string; from?: string; offer?: RTCSessionDescriptionInit; answer?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
      const from = message.from;
      if (!from) return;
      void (async () => {
        try {
          if (message.type === "offer" && message.offer) {
            const peer = createPeer(from);
            await peer.pc.setRemoteDescription(message.offer);
            for (const candidate of peer.candidates) await peer.pc.addIceCandidate(candidate);
            peer.candidates = [];
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            signal(from, { type: "answer", answer });
          } else if (message.type === "answer" && message.answer) {
            const peer = peersRef.current.get(from);
            if (!peer) return;
            await peer.pc.setRemoteDescription(message.answer);
            for (const candidate of peer.candidates) await peer.pc.addIceCandidate(candidate);
            peer.candidates = [];
          } else if (message.type === "ice-candidate" && message.candidate) {
            const peer = createPeer(from);
            if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(message.candidate);
            else peer.candidates.push(message.candidate);
          }
        } catch (signalError) {
          const code = signalError instanceof Error ? signalError.message : "Unknown signaling error";
          setError(`Peer connection setup failed: ${code}`);
        } finally {
          await remove(child.ref);
        }
      })();
    });
  }, [inRoom]);

  const createRoom = () => { setError(""); void joinFirebaseRoom(createId().replaceAll("-", "").slice(0, 8).toUpperCase()).catch((roomError) => setError(roomError instanceof Error ? roomError.message : "Could not create room.")); };
  const joinRoom = () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return setError("Enter a room code.");
    setError(""); void joinFirebaseRoom(code).catch((roomError) => setError(roomError instanceof Error ? roomError.message : "Could not join room."));
  };

  const sendFile = async () => {
    if (!file) return setError("Choose a file first.");
    const channels = [...peersRef.current.values()].map((peer) => peer.channel).filter((channel): channel is RTCDataChannel => channel?.readyState === "open");
    if (!channels.length) return setError("Wait until at least one member is connected.");
    try {
      setError(""); setProgress(0); setStatus(`Preparing ${file.name}...`);
      const metadata: Metadata = { name: file.name, size: file.size, type: file.type || "application/octet-stream", hash: await hashFile(file) };
      const transferId = createId();
      const start = JSON.stringify({ type: "file-start", transferId, metadata });
      channels.forEach((channel) => channel.send(start));
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
        for (const channel of channels) {
          if (channel.readyState !== "open") continue;
          if (channel.bufferedAmount > MAX_BUFFERED) await new Promise<void>((resolve) => {
            const wait = () => channel.bufferedAmount <= LOW_BUFFERED && (channel.removeEventListener("bufferedamountlow", wait), resolve());
            channel.addEventListener("bufferedamountlow", wait); wait();
          });
          channel.send(chunk);
        }
        const nextProgress = Math.round(((offset + chunk.byteLength) / file.size) * 100);
        setProgress(nextProgress); setStatus(`Sending ${file.name}... ${nextProgress}%`);
      }
      const complete = JSON.stringify({ type: "file-complete", transferId });
      channels.forEach((channel) => channel.readyState === "open" && channel.send(complete));
      setStatus(`Sent to ${channels.length} member${channels.length === 1 ? "" : "s"} — verification pending ✓`);
    } catch (transferError) { setError(transferError instanceof Error ? transferError.message : "Transfer failed."); setStatus("Transfer failed"); }
  };

  return <div className="app"><nav className="navbar"><div className="brand"><div className="brand-icon">P</div><span>PeerShare</span></div><div className="nav-status"><span className={`status-dot ${serverStatus !== "online" && connectedCount === 0 ? "offline" : ""}`} />{connectedCount > 0 ? "P2P active" : serverStatus === "online" ? "Ready" : serverStatus === "connecting" ? "Connecting..." : "Signaling offline"}</div></nav><main className="hero"><section className="hero-content"><div className="badge"><span>⚡</span>Private file sharing</div><h1>Share files.<br /><span>Directly.</span></h1><p className="subtitle">Create a room for up to 5 members. Every connected member can upload files and download files shared in the room.</p>{!inRoom ? <div className="room-card"><div className="room-section"><div className="room-icon">↗</div><h2>Create a transfer</h2><p>Open a room and share its code with up to 4 other devices.</p><button className="primary-button" onClick={createRoom} disabled={serverStatus !== "online"}>Create Transfer</button></div><div className="divider"><span>OR</span></div><div className="room-section"><div className="room-icon">↙</div><h2>Join a transfer</h2><p>Enter the room code shared by a member.</p><div className="join-form"><input placeholder="Enter room code" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} /><button className="secondary-button" onClick={joinRoom} disabled={serverStatus !== "online"}>Join</button></div></div></div> : <div className="room-card active-room"><div className="room-icon">✓</div><p className="room-label">TRANSFER ROOM · {memberCount}/{MAX_MEMBERS} MEMBERS</p><div className="room-code">{roomId}</div><p className="room-description">Share this code. Every member can send and download files.</p><div className="room-actions"><button className="primary-button" onClick={() => navigator.clipboard?.writeText(roomId)}>Copy Code</button><button className="secondary-button" onClick={() => window.location.reload()}>Leave</button></div><div className={`peer-status ${connectedCount > 0 ? "peer-online" : ""}`}><span className="peer-dot" />{connectedCount > 0 ? `${connectedCount} member${connectedCount === 1 ? "" : "s"} connected — ready to transfer` : "Waiting for members..."}</div><div className="file-transfer"><label className="file-picker"><input type="file" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setProgress(0); setStatus(""); }} /><span className="file-picker-icon">+</span><span>{file ? "Change file" : "Choose file"}</span></label>{file && <div className="selected-file"><div><strong>{file.name}</strong><span>{formatSize(file.size)}</span></div><button className="primary-button send-button" onClick={sendFile} disabled={!connectedCount || (progress > 0 && progress < 100)}>Send to all</button></div>}{status && <div className="transfer-progress"><div className="progress-header"><span>{status}</span><strong>{progress}%</strong></div><div className="progress-track"><div className="progress-bar" style={{ width: `${progress}%` }} /></div></div>}{downloads.map((item) => <a className="download-button" href={item.url} download={item.name} key={item.url}>↓ Download {item.name}</a>)}</div></div>}{error && <div className="error-message">{error}</div>}<div className="how-it-works"><h3>How it works</h3><div className="steps"><div className="step"><div className="step-number">01</div><strong>Up to 5 members</strong><p>Create a room and share the code.</p></div><div className="step"><div className="step-number">02</div><strong>Direct connections</strong><p>Each member connects directly to the others.</p></div><div className="step"><div className="step-number">03</div><strong>Share both ways</strong><p>Any member can upload; everyone receives a download.</p></div></div></div></section></main><footer><span>PeerShare</span><span>Private. Fast. Peer-to-peer.</span></footer></div>;
}

export default App;

# PeerShare

PeerShare sends files directly between browsers using WebRTC. The Node server is only a small signaling service: it creates rooms and passes connection negotiation messages. Files are never uploaded to it.

## What works

- Rooms with up to five members.
- Every room member can upload, and every connected member receives a download.
- Devices on the same Wi-Fi, even when the Wi-Fi has no internet access.
- Two devices on different networks when both have internet access (STUN may establish a direct path).
- Large files in chunks with backpressure.
- SHA-256 verification before a received file can be downloaded.

> Completely disconnected devices cannot discover each other through a website. For offline use, connect both devices to the same Wi-Fi/router or phone hotspot, then run the app from the computer's LAN address.

## Run on two devices on the same Wi-Fi

Install dependencies once in both folders:

- `cd server` then `npm install`
- `cd client` then `npm install`

Start the signaling server in one terminal:

- `cd server` then `npm run dev`

Start the web app in a second terminal:

- `cd client` then `npm run dev -- --host 0.0.0.0`

Find this computer's local IPv4 address with `ipconfig` (usually something like `192.168.1.20`). On both devices open:

`http://YOUR-LAN-IP:5173`

Create a room on one device, enter the displayed code on up to four other devices, wait for the members to connect, then choose and send a file. Each upload is sent directly to every connected member.

If another device cannot open the page, allow Node.js through Windows Defender Firewall on private networks and make sure both devices are on the same Wi-Fi. Guest Wi-Fi may block device-to-device traffic.

## Different networks

Use a deployed HTTPS frontend and secure WebSocket server in production. STUN alone is not guaranteed to work on restrictive networks; add a TURN server for reliable cross-network transfers. Do not expose the development server directly to the public internet.

## Deploying

GitHub Pages can host the frontend, but it cannot run the Node signaling server. Deploy `server` separately on Render, Railway, Fly.io, or a VPS. The included `render.yaml` can be used to create the Render service. The server automatically uses the hosting provider's `PORT` value.

After deployment, copy the server's secure WebSocket URL (for example `wss://peershare-signaling.onrender.com`) into the GitHub repository variable named `VITE_SIGNALING_URL`:

1. Open the repository on GitHub.
2. Go to **Settings → Secrets and variables → Actions → Variables**.
3. Add `VITE_SIGNALING_URL` with the `wss://...` server URL.
4. In **Settings → Pages**, select **GitHub Actions** as the source.
5. Push to `main` or run the **Deploy PeerShare to GitHub Pages** workflow.

The public app will be available at `https://YOUR-USERNAME.github.io/Peer2Peer/`. For reliable connections across restrictive networks, configure a TURN server and add its ICE settings in `client/src/App.tsx`.

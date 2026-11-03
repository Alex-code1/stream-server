# BeamBooth 🚀

Beam your desktop to any device on the local network.

BeamBooth is a small Node.js web server that lets one device **send** its
screen (via WebRTC `getDisplayMedia`) and another device **receive** and
display it in full screen. No accounts, no cloud — everything stays on your
LAN.

## Features

- **Role choice on the landing page** — pick *Sender* or *Receiver*, or skip
  the page entirely with URL parameters:
  - `https://<host>:8443/?role=sender&device=My%20PC`
  - `https://<host>:8443/?role=receiver&device=Living%20Room%20TV`
  - `?mode=camera` — start a sender in camera mode (handy for phone links)
- **Self-signed HTTPS** — screen capture (`getDisplayMedia`) requires a
  secure context, so the server serves over HTTPS with an auto-generated
  self-signed certificate (plus a plain-HTTP fallback for signaling).
- **Automatic receiver discovery** — senders see every receiver on the
  network in real time (join/leave/busy state updates live) and can start
  sharing with one click.
- **Receiver idle screen** — shows the device name and IP while waiting.
- **Full-screen remote view** — when a sender connects, the receiver shows
  the remote screen (with audio) edge to edge.
- **Take-over rule** — if a new sender connects to a receiver that is
  already in use, the receiver switches to the new sender and the old
  sender is notified.
- **Mobile support** — phones and tablets can receive streams, and can send
  their camera where the browser and device permissions allow it. Screen
  sharing depends on browser support; Firefox on Android does not expose
  screen capture. Camera sharing does **not** share the phone's screen.
- **Chrome & Firefox** — uses standard WebRTC APIs; on a LAN no STUN/TURN
  servers are needed.

## Quick start

```bash
npm install
npm start
```

The server prints the local and network URLs, e.g.
`https://192.168.0.78:8443`. **Open the HTTPS URL** on the sending device
and the receiving device.

> **First visit:** the certificate is self-signed, so the browser shows a
> security warning. Click *Advanced* → *Proceed to <host> (unsafe)* (or
> type `thisisunsafe` in Chrome). Do this on each device once; the
> certificate is generated on first start and reused afterwards.

- **Sender**: choose *I'm a Sender* → pick a receiver from the list →
  allow screen sharing.
- **Receiver**: choose *I'm a Receiver* → wait for a sender.

Use the `PORT` (default `8080`) and `HTTPS_PORT` (default `8443`)
environment variables to change the ports.

### Camera permissions on Android

Open the HTTPS address in Firefox and allow the certificate warning and the
site's camera permission prompt. In Firefox's site permissions, clear any
previously blocked camera or microphone permission and try again. Also check
Android **Settings → Apps → Firefox → Permissions** and allow Camera (and
Microphone if needed). The exact menu names vary by Android and Firefox version.
When screen capture is unavailable, camera sharing starts with microphone audio
off; select **Include microphone audio** to request it. If microphone access is
unavailable, leave it off to share camera video only. A website cannot override a permission denial, device
policy, or browser restriction; self-signed certificates may also be rejected
for media access on some configurations.

Firefox on Android may not support sharing the phone screen via a web page.
The camera option is separate and cannot capture other apps or the display.

## How it works

```
Sender (browser)                Server (Node.js)              Receiver (browser)
     │  WebSocket /ws                │                              │
     │  hello (role=sender)          │                              │
     │  hello (role=receiver)        │◄─────────────────────────────│
     │◄─ receivers list ─────────────│  (registry: pushes list to   │
     │◄─ receivers updates ──────────│   every sender on change)    │
     │  connect (receiverId)         │                              │
     │◄─ connected ──────────────────│  (switches receiver if busy) │
     │──────────────────────────────►│─────────────────────────────►│
     │  WebRTC offer/answer/ICE relayed through the server           │
     │◄══════════════ WebRTC media (screen + audio) ═══════════════►│
```

- The server is a **signaling relay + registry** only; the actual screen
  stream flows peer-to-peer over WebRTC (UDP).
- ICE servers are intentionally empty — on a local network host
  candidates are sufficient.

## Running on Debian

```bash
# 1. Install Node.js (Debian 12 ships Node 18, which is fine)
sudo apt update
sudo apt install -y nodejs npm

# 2. Copy the project to the server, e.g. /opt/beambooth
sudo -u deploy mkdir -p /opt/beambooth
#    (copy server.js, package.json, public/ there)
cd /opt/beambooth
npm install --omit=dev

# 3. Run as a systemd service
sudo tee /etc/systemd/system/beambooth.service > /dev/null <<'EOF'
[Unit]
Description=BeamBooth - LAN desktop streaming
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/beambooth
ExecStart=/usr/bin/node server.js
Restart=on-failure
User=beambooth
Environment=PORT=8080
Environment=HTTPS_PORT=8443

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now beambooth
```

Then open `https://<server-ip>:8443` on your devices (accept the
self-signed certificate warning once per device).

> **Why HTTPS?** `getDisplayMedia` (screen capture) is only available in a
> **secure context** — HTTPS or `localhost`. A plain `http://<lan-ip>`
> page has `navigator.mediaDevices` undefined, so screen sharing would
> fail. BeamBooth therefore serves over HTTPS with a self-signed
> certificate (generated on first start, stored in `certs/`). The plain
> HTTP port is kept for signaling-only use and local development.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | HTTP + HTTPS static server + WebSocket signaling/registry |
| `public/index.html` | Landing page, sender and receiver views |
| `public/style.css` | Styling |
| `public/app.js` | Client logic (WebSocket, WebRTC, UI) |
| `certs/` | Self-signed certificate (auto-generated on first start) |
| `test-signaling.js` | End-to-end signaling test (run `node test-signaling.js` with the server up) |
| `test-cert.js` | Verifies the self-signed HTTPS server responds (run `node test-cert.js`) |
| `test-capture.js` | Tests capture permissions and video-only retry (run `node test-capture.js`) |

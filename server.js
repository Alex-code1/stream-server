'use strict';

/**
 * BeamBooth server
 * ----------------
 * - Serves the static web app (public/)
 * - Runs a WebSocket signaling server (ws://host:port/ws)
 *
 * The server acts as a registry:
 *   - Every receiver announces itself (role=receiver) and stays registered.
 *   - Every sender gets the live list of receivers and is notified when
 *     receivers join/leave.
 *   - Signaling (WebRTC offer/answer/ICE) is relayed between a sender and
 *     the receiver it targets.
 *   - If a new sender connects to a receiver that already has a sender,
 *     the receiver is switched to the new sender (the old sender is told).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HTTPS_PORT = process.env.HTTPS_PORT ? Number(process.env.HTTPS_PORT) : 8443;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');
const CERT_FILE = path.join(CERT_DIR, 'beambooth.crt');
const KEY_FILE = path.join(CERT_DIR, 'beambooth.key');

/* ------------------------------------------------------------------ */
/* Static file serving                                                 */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* Signaling / registry                                                */
/* ------------------------------------------------------------------ */

/**
 * clients: Map<socket, ClientInfo>
 * ClientInfo = {
 *   id: string,
 *   role: 'sender' | 'receiver',
 *   deviceName: string,
 *   ip: string,
 *   targetId: string | null,   // sender -> receiver id it is connected to
 *   senderId: string | null,   // receiver -> sender id currently streaming
 * }
 */
const clients = new Map();
let nextId = 1;

function clientIp(req) {
  let ip = (req && req.socket && req.socket.remoteAddress) || 'unknown';
  // Normalize IPv6-mapped and loopback forms for a cleaner display.
  if (ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '127.0.0.1') ip = 'localhost';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function send(ws, obj) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(obj));
  }
}

function receiverList() {
  const list = [];
  for (const [ws, info] of clients) {
    if (info.role === 'receiver') {
      list.push({
        id: info.id,
        deviceName: info.deviceName,
        ip: info.ip,
        busy: info.senderId !== null,
      });
    }
  }
  return list;
}

function broadcastReceivers() {
  const receivers = receiverList();
  for (const [ws, info] of clients) {
    if (info.role === 'sender') send(ws, { type: 'receivers', receivers });
  }
}

function receiverInfo(id) {
  for (const [ws, info] of clients) {
    if (info.id === id && info.role === 'receiver') return { ws, info };
  }
  return null;
}

function senderInfo(id) {
  for (const [ws, info] of clients) {
    if (info.id === id && info.role === 'sender') return { ws, info };
  }
  return null;
}

/**
 * Establish (or switch) a sender -> receiver connection.
 * If the receiver already has a sender, the old sender is disconnected
 * and the receiver switches to the new one.
 */
function connectSenderToReceiver(senderWs, sInfo, receiverId) {
  const target = receiverInfo(receiverId);
  if (!target) {
    send(senderWs, { type: 'error', message: 'Receiver not found (it may have left).' });
    return;
  }
  const receiverWs = target.ws;
  const rInfo = target.info;

  // Switch: kick the previous sender if any.
  if (rInfo.senderId && rInfo.senderId !== sInfo.id) {
    const old = senderInfo(rInfo.senderId);
    if (old) {
      send(old.ws, {
        type: 'disconnected',
        reason: 'switched',
        message: 'The receiver switched to a new sender.',
      });
      old.info.targetId = null;
    }
    send(receiverWs, { type: 'sender_left', reason: 'switched' });
  }

  rInfo.senderId = sInfo.id;
  sInfo.targetId = receiverId;

  send(receiverWs, {
    type: 'sender_connected',
    sender: { id: sInfo.id, deviceName: sInfo.deviceName, ip: sInfo.ip },
  });
  send(senderWs, {
    type: 'connected',
    receiver: { id: rInfo.id, deviceName: rInfo.deviceName, ip: rInfo.ip },
  });
  broadcastReceivers();
}

function disconnectSender(senderWs, sInfo) {
  if (sInfo.targetId) {
    const target = receiverInfo(sInfo.targetId);
    if (target && target.info.senderId === sInfo.id) {
      target.info.senderId = null;
      send(target.ws, { type: 'sender_left', reason: 'left' });
    }
    sInfo.targetId = null;
  }
  broadcastReceivers();
}

function handleSignal(ws, info, msg) {
  // Relay WebRTC signaling to the paired peer.
  const peerId =
    info.role === 'sender' ? info.targetId : info.senderId;
  if (!peerId) {
    send(ws, { type: 'error', message: 'No active peer for signaling.' });
    return;
  }
  const peer = info.role === 'sender' ? receiverInfo(peerId) : senderInfo(peerId);
  if (!peer) {
    send(ws, { type: 'error', message: 'Peer no longer available.' });
    return;
  }
  send(peer.ws, {
    type: msg.type, // 'offer' | 'answer' | 'ice'
    sdp: msg.sdp,
    from: { id: info.id, deviceName: info.deviceName },
  });
}

function handleWs(ws, req) {
  const info = {
    id: 'c' + nextId++,
    role: null,
    deviceName: 'Unknown device',
    ip: clientIp(req),
    targetId: null,
    senderId: null,
  };
  clients.set(ws, info);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello': {
        info.role = msg.role === 'sender' ? 'sender' : 'receiver';
        if (typeof msg.deviceName === 'string' && msg.deviceName.trim()) {
          info.deviceName = msg.deviceName.trim().slice(0, 64);
        }
        if (info.role === 'sender') {
          send(ws, {
            type: 'hello_ack',
            id: info.id,
            receivers: receiverList(),
          });
        } else {
          send(ws, { type: 'hello_ack', id: info.id });
          broadcastReceivers();
        }
        break;
      }

      case 'connect': {
        // Sender requests to connect to a receiver id.
        if (info.role !== 'sender') break;
        connectSenderToReceiver(ws, info, String(msg.receiverId || ''));
        break;
      }

      case 'disconnect': {
        if (info.role === 'sender') {
          disconnectSender(ws, info);
        } else if (info.role === 'receiver' && info.senderId) {
          const s = senderInfo(info.senderId);
          if (s) {
            send(s.ws, { type: 'disconnected', reason: 'rejected', message: 'The receiver ended the session.' });
            s.info.targetId = null;
          }
          info.senderId = null;
          broadcastReceivers();
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice':
        handleSignal(ws, info, msg);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (info.role === 'sender') {
      disconnectSender(ws, info);
    } else if (info.role === 'receiver') {
      if (info.senderId) {
        const s = senderInfo(info.senderId);
        if (s) {
          send(s.ws, { type: 'disconnected', reason: 'left', message: 'The receiver left.' });
          s.info.targetId = null;
        }
      }
      broadcastReceivers();
    }
  });

  ws.on('error', () => {
    /* close handler cleans up */
  });
}

/* ------------------------------------------------------------------ */
/* Self-signed TLS certificate                                         */
/* ------------------------------------------------------------------ */

/**
 * Browsers only expose navigator.mediaDevices.getDisplayMedia in a secure
 * context, so the app must be served over HTTPS (or on localhost). We
 * generate a self-signed certificate on first start and reuse it afterwards.
 *
 * Returns a Promise resolving to { key, cert } or null when generation fails.
 */
async function ensureSelfSignedCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return {
      key: fs.readFileSync(KEY_FILE),
      cert: fs.readFileSync(CERT_FILE),
    };
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });

  // Generate with the `selfsigned` package (pure JS, no external tools).
  try {
    const selfsigned = require('selfsigned');
    const attrs = [{ name: 'commonName', value: 'beambooth.local' }];
    const { private: key, cert } = await selfsigned.generate(attrs, {
      keySize: 2048,
      days: 3650,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', keyCertSign: false, digitalSignature: true, keyEncipherment: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'beambooth.local' },
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    });
    fs.writeFileSync(KEY_FILE, key);
    fs.writeFileSync(CERT_FILE, cert);
    return { key, cert };
  } catch (err) {
    console.warn('  ! Could not generate a self-signed certificate:', err.message);
    return null;
  }
}


/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function localIps() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

async function start() {
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', handleWs);

  let httpsServer = null;
  const tls = await ensureSelfSignedCert();
  if (tls) {
    httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, serveStatic);
    const wssHttps = new WebSocketServer({ server: httpsServer, path: '/ws' });
    wssHttps.on('connection', handleWs);
  }

  server.listen(PORT, () => {
    const ips = localIps();
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║           B E A M B O O T H              ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    if (httpsServer) {
      console.log('  HTTPS (use these for screen sharing):');
      console.log(`  Local:   https://localhost:${HTTPS_PORT}`);
      for (const ip of ips) {
        console.log(`  Network: https://${ip}:${HTTPS_PORT}`);
      }
      console.log('');
      console.log('  The certificate is self-signed — accept the browser');
      console.log('  security warning on each device (click "Advanced" →');
      console.log('  "Proceed to <host>").');
    } else {
      console.log('  ! HTTPS unavailable (no certificate tool found).');
      console.log('    Screen sharing will only work on localhost.');
    }
    console.log('');
    console.log('  HTTP (signaling only, no screen capture):');
    console.log(`  Local:   http://localhost:${PORT}`);
    for (const ip of ips) {
      console.log(`  Network: http://${ip}:${PORT}`);
    }
    console.log('');
    console.log('  Open the HTTPS URL on a sender and a receiver device.');
    console.log('');
  });

  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, () => {
      console.log(`  HTTPS server listening on port ${HTTPS_PORT}`);
    });
    httpsServer.on('error', (err) => {
      console.error(`  ! HTTPS server failed to start on port ${HTTPS_PORT}:`, err.message);
    });
  }
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start BeamBooth:', err);
    process.exit(1);
  });
}

module.exports = { ensureSelfSignedCert, start };

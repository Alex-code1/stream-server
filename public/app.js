'use strict';

/* ================================================================== */
/* BeamBooth client                                                    */
/* ================================================================== */

const $ = (id) => document.getElementById(id);

const els = {
  landing: $('landing'),
  sender: $('sender'),
  receiver: $('receiver'),
  deviceName: $('deviceName'),
  btnSender: $('btnSender'),
  btnReceiver: $('btnReceiver'),
  senderStatus: $('senderStatus'),
  receiverList: $('receiverList'),
  noReceivers: $('noReceivers'),
  senderListWrap: $('senderListWrap'),
  senderSharing: $('senderSharing'),
  shareTargetName: $('shareTargetName'),
  shareTargetIp: $('shareTargetIp'),
  btnStopShare: $('btnStopShare'),
  captureModeToggle: $('captureModeToggle'),
  captureModeHint: $('captureModeHint'),
  cameraAudioOption: $('cameraAudioOption'),
  cameraAudio: $('cameraAudio'),
  captureError: $('captureError'),
  shareModeLabel: $('shareModeLabel'),
  receiverIdle: $('receiverIdle'),
  receiverLive: $('receiverLive'),
  receiverDeviceName: $('receiverDeviceName'),
  receiverIp: $('receiverIp'),
  remoteVideo: $('remoteVideo'),
  liveSenderName: $('liveSenderName'),
  btnUnmute: $('btnUnmute'),
  btnStopReceive: $('btnStopReceive'),
  toast: $('toast'),
};

/* ------------------------- State ------------------------- */

const state = {
  role: null, // 'sender' | 'receiver'
  deviceName: '',
  ws: null,
  myId: null,
  receivers: [], // [{id, deviceName, ip, busy}]
  // sender
  pc: null,
  stream: null,
  capturePending: false,
  captureMode: 'screen', // 'screen' | 'camera'
  targetId: null,
  targetName: '',
  targetIp: '',
  // receiver
  currentSender: null, // {id, deviceName}
};

/* ------------------------- Helpers ------------------------- */

function showScreen(name) {
  for (const s of [els.landing, els.sender, els.receiver]) s.classList.add('hidden');
  ({ landing: els.landing, sender: els.sender, receiver: els.receiver }[name]).classList.remove('hidden');
}

let toastTimer = null;
function toast(msg, isError = false) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 4000);
}

function defaultDeviceName() {
  const nav = navigator;
  const parts = [];
  if (nav.platform) parts.push(nav.platform.replace(/ /g, '-'));
  if (nav.userAgent.includes('Firefox')) parts.push('Firefox');
  else if (nav.userAgent.includes('Edg/')) parts.push('Edge');
  else if (nav.userAgent.includes('Chrome')) parts.push('Chrome');
  return parts.length ? parts.join(' · ') : 'My device';
}

function captureCapabilities() {
  const md = navigator.mediaDevices;
  const screen = !!(md && typeof md.getDisplayMedia === 'function');
  const camera = !!(md && typeof md.getUserMedia === 'function');
  return { screen, camera };
}

/* ------------------------- WebSocket ------------------------- */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function connectWs() {
  const ws = new WebSocket(wsUrl());
  state.ws = ws;

  ws.onopen = () => {
    wsSend({
      type: 'hello',
      role: state.role,
      deviceName: state.deviceName,
    });
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(msg);
  };

  ws.onclose = () => {
    if (state.role === 'sender') {
      teardownSenderPc();
      showSharingUI(false);
      setStatus('Disconnected — reconnecting…', 'err');
    }
    // Reconnect after a short delay.
    setTimeout(() => {
      if (state.role) connectWs();
    }, 1500);
  };

  ws.onerror = () => {
    /* onclose handles reconnect */
  };
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function setStatus(text, cls) {
  els.senderStatus.textContent = text;
  els.senderStatus.className = 'topbar-status' + (cls ? ' ' + cls : '');
}

/* ------------------------- Message handling ------------------------- */

function onMessage(msg) {
  switch (msg.type) {
    case 'hello_ack':
      state.myId = msg.id;
      if (state.role === 'sender') {
        setStatus('Connected', 'ok');
        state.receivers = msg.receivers || [];
        renderReceiverList();
      }
      break;

    case 'receivers':
      state.receivers = msg.receivers || [];
      renderReceiverList();
      break;

    case 'connected':
      // Sender: we are now streaming to msg.receiver
      state.targetId = msg.receiver.id;
      state.targetName = msg.receiver.deviceName;
      state.targetIp = msg.receiver.ip;
      showSharingUI(true);
      setStatus('Sharing', 'ok');
      break;

    case 'disconnected':
      // Sender: receiver went away or switched
      teardownSenderPc();
      showSharingUI(false);
      setStatus('Connected', 'ok');
      toast(msg.message || 'Disconnected from receiver.', true);
      break;

    case 'sender_connected':
      // Receiver: a sender is now streaming to us
      state.currentSender = msg.sender;
      showReceiverLive(true, msg.sender.deviceName);
      break;

    case 'sender_left':
      // Receiver: sender went away (or was switched out)
      teardownReceiverPc();
      showReceiverLive(false);
      break;

    case 'offer':
      handleOffer(msg);
      break;

    case 'answer':
      handleAnswer(msg);
      break;

    case 'ice':
      handleIce(msg);
      break;

    case 'error':
      if (state.role === 'sender' && state.stream) {
        teardownSenderPc();
        showSharingUI(false);
        setStatus('Connected', 'ok');
      }
      toast(msg.message || 'Error', true);
      break;

    default:
      break;
  }
}

/* ================================================================== */
/* SENDER                                                              */
/* ================================================================== */

function renderReceiverList() {
  const list = els.receiverList;
  list.innerHTML = '';
  const hasAny = state.receivers.length > 0;
  els.noReceivers.classList.toggle('hidden', hasAny);

  for (const r of state.receivers) {
    const item = document.createElement('div');
    item.className = 'receiver-item';

    const icon = document.createElement('div');
    icon.className = 'ri-icon';
    icon.textContent = '📺';

    const main = document.createElement('div');
    main.className = 'ri-main';
    const name = document.createElement('div');
    name.className = 'ri-name';
    name.textContent = r.deviceName;
    const ip = document.createElement('div');
    ip.className = 'ri-ip';
    ip.textContent = r.ip;
    main.append(name, ip);

    const badge = document.createElement('div');
    badge.className = 'ri-badge' + (r.busy ? ' busy' : '');
    badge.textContent = r.busy ? 'In use' : 'Free';

    const cta = document.createElement('div');
    cta.className = 'ri-cta';
    cta.textContent = r.busy ? 'Take over →' : 'Share →';

    item.append(icon, main, badge, cta);
    item.addEventListener('click', () => startSharing(r));
    list.appendChild(item);
  }
}

function showSharingUI(show) {
  els.senderListWrap.classList.toggle('hidden', show);
  els.senderSharing.classList.toggle('hidden', !show);
  if (show) {
    els.shareTargetName.textContent = state.targetName;
    els.shareTargetIp.textContent = state.targetIp;
    els.shareModeLabel.textContent = state.captureMode === 'camera'
      ? (state.stream && state.stream.getAudioTracks().length ? 'Sharing camera + microphone' : 'Sharing camera')
      : 'Sharing screen';
  }
}

/**
 * Acquire the media stream for the selected capture mode.
 *  - screen: getDisplayMedia — screen and optional system audio
 *  - camera: getUserMedia — camera and optional microphone
 */
async function getStream(mode, includeMicrophone) {
  const md = navigator.mediaDevices;
  if (!md) throw new Error('Media capture is not available in this browser.');

  if (mode === 'camera') {
    return md.getUserMedia({
      video: {
        facingMode: 'environment', // rear camera on phones
        frameRate: { ideal: 30 },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: includeMicrophone,
    });
  }

  // Default: screen capture.
  if (typeof md.getDisplayMedia !== 'function') {
    throw new Error(
      'Screen capture is not supported on this device. Switch to Camera mode instead.'
    );
  }
  return md.getDisplayMedia({
    video: {
      frameRate: 30,
      // Prefer a reasonable resolution; the receiver scales anyway.
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: true,
  });
}

function captureErrorMessage(err, mode) {
  if (!window.isSecureContext) {
    return 'Media capture requires a secure context. Open BeamBooth using its HTTPS address and accept the certificate warning.';
  }
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    if (mode === 'camera') {
      return 'Camera or microphone permission was denied. Allow camera access for this site in Firefox site permissions and for Firefox in Android Settings → Apps → Firefox → Permissions. If microphone access is blocked, turn off Include microphone audio and try again. A self-signed certificate or browser policy may also prevent access.';
    }
    return 'Screen sharing was denied or blocked. Allow the browser’s screen sharing prompt and check the browser’s site permissions.';
  }
  return 'Could not access your ' + mode + ': ' + (err.message || err.name || 'Unknown error');
}

async function startSharing(receiver) {
  if (state.capturePending || state.stream) return;
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    els.captureError.textContent = 'Not connected to the server. Wait for reconnection and try again.';
    els.captureError.classList.remove('hidden');
    return;
  }
  const ws = state.ws;
  const mode = state.captureMode;
  state.capturePending = true;
  els.captureError.classList.add('hidden');
  let stream;
  try {
    stream = await getStream(mode, els.cameraAudio.checked);
  } catch (err) {
    els.captureError.textContent = captureErrorMessage(err, mode);
    els.captureError.classList.remove('hidden');
    state.capturePending = false;
    return;
  }
  state.capturePending = false;
  if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) {
    for (const track of stream.getTracks()) track.stop();
    els.captureError.textContent = 'Connection to the server was lost. Try again after reconnecting.';
    els.captureError.classList.remove('hidden');
    return;
  }
  state.stream = stream;
  wsSend({ type: 'connect', receiverId: receiver.id });

  // If the user stops sharing via the browser's own "Stop sharing" pill,
  // tear everything down.
  const videoTrack = state.stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.addEventListener('ended', () => {
      teardownSenderPc();
      showSharingUI(false);
      setStatus('Connected', 'ok');
      wsSend({ type: 'disconnect' });
    });
  }

  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: [] });
    state.pc = pc;

    for (const track of state.stream.getTracks()) {
      pc.addTrack(track, state.stream);
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) wsSend({ type: 'ice', sdp: ev.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setTimeout(() => {
          if (state.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
            teardownSenderPc();
            showSharingUI(false);
            setStatus('Connected', 'ok');
            wsSend({ type: 'disconnect' });
            toast('Connection to receiver lost.', true);
          }
        }, 3000);
      }
    };

    const offer = await pc.createOffer();
    if (state.pc !== pc) return;
    await pc.setLocalDescription(offer);
    if (state.pc === pc) wsSend({ type: 'offer', sdp: pc.localDescription });
  } catch (err) {
    if (pc && state.pc !== pc) return;
    teardownSenderPc();
    showSharingUI(false);
    setStatus('Connected', 'ok');
    wsSend({ type: 'disconnect' });
    els.captureError.textContent = 'Could not start sharing: ' + err.message;
    els.captureError.classList.remove('hidden');
  }
}

function teardownSenderPc() {
  if (state.pc) {
    state.pc.onicecandidate = null;
    state.pc.onconnectionstatechange = null;
    state.pc.close();
    state.pc = null;
  }
  if (state.stream) {
    for (const t of state.stream.getTracks()) t.stop();
    state.stream = null;
  }
  state.targetId = null;
}

/* ================================================================== */
/* RECEIVER                                                            */
/* ================================================================== */

function showReceiverLive(show, senderName) {
  els.receiverIdle.classList.toggle('hidden', show);
  els.receiverLive.classList.toggle('hidden', !show);
  if (show) {
    els.liveSenderName.textContent = senderName || '…';
    // Autoplay with audio can be blocked (e.g. when the page was opened
    // via a URL with no user gesture). Fall back to muted autoplay so the
    // screen is always shown; the user can unmute via the button.
    els.remoteVideo.muted = false;
    els.btnUnmute.classList.add('hidden');
    els.remoteVideo
      .play()
      .catch(() => {
        els.remoteVideo.muted = true;
        els.btnUnmute.classList.remove('hidden');
        els.remoteVideo.play().catch(() => {});
      });
  }
}

async function handleOffer(msg) {
  // (Re)create the peer connection for the incoming sender.
  teardownReceiverPc();

  const pc = new RTCPeerConnection({ iceServers: [] });
  state.pc = pc;

  pc.ontrack = (ev) => {
    const [stream] = ev.streams;
    if (stream && els.remoteVideo.srcObject !== stream) {
      els.remoteVideo.srcObject = stream;
    }
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      wsSend({ type: 'ice', sdp: ev.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setTimeout(() => {
        if (state.pc === pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
          teardownReceiverPc();
          showReceiverLive(false);
          wsSend({ type: 'disconnect' });
        }
      }, 3000);
    }
  };

  await pc.setRemoteDescription(msg.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: 'answer', sdp: pc.localDescription });
}

async function handleAnswer(msg) {
  if (!state.pc) return;
  await state.pc.setRemoteDescription(msg.sdp);
}

async function handleIce(msg) {
  if (!state.pc) return;
  try {
    await state.pc.addIceCandidate(msg.sdp);
  } catch (err) {
    // Ignore stale candidates.
  }
}

function teardownReceiverPc() {
  if (state.pc) {
    state.pc.ontrack = null;
    state.pc.onicecandidate = null;
    state.pc.onconnectionstatechange = null;
    state.pc.close();
    state.pc = null;
  }
  if (els.remoteVideo.srcObject) {
    const stream = els.remoteVideo.srcObject;
    els.remoteVideo.srcObject = null;
    for (const t of stream.getTracks()) t.stop();
  }
  state.currentSender = null;
}

/* ================================================================== */
/* BOOTSTRAP                                                           */
/* ================================================================== */

function start(role) {
  state.role = role;
  state.deviceName = els.deviceName.value.trim() || defaultDeviceName();

  if (role === 'sender') {
    showScreen('sender');
    connectWs();
  } else {
    showScreen('receiver');
    els.receiverDeviceName.textContent = state.deviceName;
    // Best-effort local IP display (WebRTC trick).
    detectLocalIp().then((ip) => {
      els.receiverIp.textContent = ip || 'on this network';
    });
    connectWs();
  }
}

/**
 * Best-effort detection of the local LAN IP using a throwaway WebRTC
 * connection. Works on Chrome and Firefox (may be blocked in some
 * privacy modes; falls back gracefully).
 */
function detectLocalIp() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ip) => {
      if (done) return;
      done = true;
      try {
        if (pc) pc.close();
      } catch {}
      resolve(ip);
    };
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch {
      finish(null);
      return;
    }
    const timeout = setTimeout(() => finish(null), 3000);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const m = ev.candidate.candidate.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
      if (m) {
        const ip = m[1];
        if (!ip.startsWith('127.')) {
          clearTimeout(timeout);
          finish(ip);
        }
      }
    };
    pc.createDataChannel('probe');
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(() => {
        clearTimeout(timeout);
        finish(null);
      });
  });
}

function setupCaptureMode(preferredMode) {
  const caps = captureCapabilities();

  if (!caps.screen && caps.camera) {
    state.captureMode = 'camera';
    els.cameraAudio.checked = false;
  } else if (preferredMode === 'camera' && caps.camera) {
    state.captureMode = 'camera';
  }

  const opts = els.captureModeToggle.querySelectorAll('.mode-opt');
  for (const btn of opts) {
    const mode = btn.dataset.mode;
    const supported = mode === 'screen' ? caps.screen : caps.camera;
    if (!supported) {
      btn.disabled = true;
      btn.classList.add('disabled');
    }
    btn.addEventListener('click', () => {
      if (btn.disabled || state.capturePending || state.stream) return;
      state.captureMode = mode;
      for (const b of opts) b.classList.toggle('active', b === btn);
      els.cameraAudioOption.classList.toggle('hidden', mode !== 'camera');
      els.captureError.classList.add('hidden');
    });
  }

  // Reflect the active mode.
  for (const btn of opts) {
    btn.classList.toggle('active', btn.dataset.mode === state.captureMode);
  }
  els.cameraAudioOption.classList.toggle('hidden', state.captureMode !== 'camera' || !caps.camera);

  // Explain the situation to the user.
  if (!caps.screen && caps.camera) {
    els.captureModeHint.textContent =
      'Screen capture isn’t available in this browser. Camera sharing is separate and does not share your screen.';
  } else if (!caps.screen && !caps.camera) {
    els.captureModeHint.textContent =
      'Capture is unavailable. Open the HTTPS address in a browser that supports media capture.';
  } else if (caps.screen && caps.camera) {
    els.captureModeHint.textContent =
      'Pick what to share: your screen or your camera.';
  }
}

function init() {
  els.deviceName.value = defaultDeviceName();

  // URL parameters: ?role=sender|receiver&device=Name&mode=screen|camera
  const params = new URLSearchParams(location.search);
  const urlRole = (params.get('role') || '').toLowerCase();
  const urlDevice = params.get('device');
  const urlMode = (params.get('mode') || '').toLowerCase();
  if (urlDevice) els.deviceName.value = urlDevice;

  setupCaptureMode(urlMode);

  els.btnSender.addEventListener('click', () => start('sender'));
  els.btnReceiver.addEventListener('click', () => start('receiver'));
  els.deviceName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') start('sender');
  });

  els.btnStopShare.addEventListener('click', () => {
    teardownSenderPc();
    showSharingUI(false);
    setStatus('Connected', 'ok');
    wsSend({ type: 'disconnect' });
  });

  els.btnStopReceive.addEventListener('click', () => {
    teardownReceiverPc();
    showReceiverLive(false);
    wsSend({ type: 'disconnect' });
  });

  els.btnUnmute.addEventListener('click', () => {
    els.remoteVideo.muted = false;
    els.btnUnmute.classList.add('hidden');
  });

  if (urlRole === 'sender' || urlRole === 'receiver') {
    start(urlRole);
  }
}

init();

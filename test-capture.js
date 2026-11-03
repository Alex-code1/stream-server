'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createApp(getUserMedia, secure = true) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        textContent: '', value: '', checked: true, dataset: {}, disabled: false,
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          toggle: (name, force) => {
            if (force === undefined) force = !classes.has(name);
            if (force) classes.add(name); else classes.delete(name);
          },
          contains: (name) => classes.has(name),
        },
        addEventListener() {},
      });
    }
    return elements.get(id);
  }
  const screen = element('screenMode');
  screen.dataset.mode = 'screen';
  const camera = element('cameraMode');
  camera.dataset.mode = 'camera';
  element('captureModeToggle').querySelectorAll = () => [screen, camera];

  const sent = [];
  class WebSocket {
    static get OPEN() { return 1; }
    constructor() { this.readyState = 1; }
    send(message) { sent.push(JSON.parse(message)); }
  }
  class RTCPeerConnection {
    addTrack() {}
    close() {}
    async createOffer() { return { type: 'offer', sdp: 'test' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
  }
  const context = vm.createContext({
    document: { getElementById: element },
    navigator: { platform: 'Android', userAgent: 'Firefox', mediaDevices: { getUserMedia } },
    location: { protocol: 'https:', host: 'localhost', search: '' },
    window: { isSecureContext: secure },
    URLSearchParams, WebSocket, RTCPeerConnection,
    setTimeout() {}, clearTimeout() {}, console,
  });
  vm.runInContext(fs.readFileSync('public/app.js', 'utf8'), context);
  vm.runInContext('state.ws = new WebSocket()', context);
  return {
    context, element, sent, screen, camera,
    share: () => vm.runInContext("startSharing({ id: 'receiver' })", context),
  };
}

function makeStream() {
  const track = { stopped: false, addEventListener() {}, stop() { this.stopped = true; } };
  return {
    track,
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
  };
}

(async () => {
  const calls = [];
  const stream = makeStream();
  const app = createApp(async (constraints) => {
    calls.push(constraints);
    if (constraints.audio) {
      const err = new Error('The request is not allowed by the user agent or the platform in the current context.');
      err.name = 'NotAllowedError';
      throw err;
    }
    return stream;
  });
  assert.equal(app.screen.disabled, true);
  assert.equal(app.camera.classList.contains('active'), true);
  assert.match(app.element('captureModeHint').textContent, /does not share your screen/);
  assert.equal(app.element('cameraAudio').checked, false);
  app.element('cameraAudio').checked = true;
  await app.share();
  assert.equal(calls[0].audio, true);
  assert.deepEqual(app.sent, []);
  assert.match(app.element('captureError').textContent, /Android Settings/);
  assert.match(app.element('captureError').textContent, /Include microphone audio/);
  assert.equal(app.element('captureError').classList.contains('hidden'), false);

  app.element('cameraAudio').checked = false;
  await app.share();
  assert.equal(calls[1].audio, false);
  assert.deepEqual(app.sent.map((message) => message.type), ['connect', 'offer']);
  assert.equal(app.element('captureError').classList.contains('hidden'), true);

  const insecure = createApp(async () => { throw new Error('Unavailable'); }, false);
  await insecure.share();
  assert.match(insecure.element('captureError').textContent, /HTTPS/);
  assert.deepEqual(insecure.sent, []);

  let resolveCapture;
  const pending = createApp(() => new Promise((resolve) => { resolveCapture = resolve; }));
  const operation = pending.share();
  await pending.share();
  assert.deepEqual(pending.sent, []);
  vm.runInContext('state.ws.readyState = 3', pending.context);
  const lateStream = makeStream();
  resolveCapture(lateStream);
  await operation;
  assert.equal(lateStream.track.stopped, true);
  assert.deepEqual(pending.sent, []);
  assert.match(pending.element('captureError').textContent, /lost/);

  console.log('Capture permission, video-only retry, and connection tests passed.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

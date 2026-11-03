'use strict';
/* End-to-end signaling test for BeamBooth (no browser needed). */
const WebSocket = require('ws');

const URL = 'ws://localhost:8080/ws';
let failures = 0;

function check(name, cond) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}`);
  }
}

class Client {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(URL);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
    });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  waitFor(pred, timeoutMs = 3000) {
    // Check history first.
    const found = this.messages.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: timeout waiting for message`)), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

(async () => {
  console.log('BeamBooth signaling test\n');

  // 1. Receiver joins.
  const receiver = new Client('receiver');
  await new Promise((r) => receiver.ws.on('open', r));
  receiver.send({ type: 'hello', role: 'receiver', deviceName: 'Living Room TV' });
  const rAck = await receiver.waitFor((m) => m.type === 'hello_ack');
  check('receiver gets hello_ack with id', typeof rAck.id === 'string');

  // 2. Sender joins and should see the receiver.
  // Note: other receivers may be registered on the network (e.g. a real
  // browser tab), so locate OUR receiver by its unique device name.
  const sender1 = new Client('sender1');
  await new Promise((r) => sender1.ws.on('open', r));
  sender1.send({ type: 'hello', role: 'sender', deviceName: 'Alice PC' });
  const sAck = await sender1.waitFor((m) => m.type === 'hello_ack');
  const ourReceiver = (sAck.receivers || []).find((r) => r.deviceName === 'Living Room TV');
  check('sender sees receiver in hello_ack', !!ourReceiver);
  const receiverId = ourReceiver.id;

  // 3. Sender connects to receiver.
  sender1.send({ type: 'connect', receiverId });
  const sConn = await sender1.waitFor((m) => m.type === 'connected');
  const rConn = await receiver.waitFor((m) => m.type === 'sender_connected');
  check('sender gets connected with receiver info', sConn.receiver && sConn.receiver.deviceName === 'Living Room TV');
  check('receiver gets sender_connected with sender info', rConn.sender && rConn.sender.deviceName === 'Alice PC');

  // 4. Signaling relay: sender offer -> receiver, receiver answer -> sender, ICE both ways.
  sender1.send({ type: 'offer', sdp: { type: 'offer', sdp: 'fake-offer' } });
  const rOffer = await receiver.waitFor((m) => m.type === 'offer');
  check('receiver receives offer', rOffer.sdp && rOffer.sdp.sdp === 'fake-offer');

  receiver.send({ type: 'answer', sdp: { type: 'answer', sdp: 'fake-answer' } });
  const sAnswer = await sender1.waitFor((m) => m.type === 'answer');
  check('sender receives answer', sAnswer.sdp && sAnswer.sdp.sdp === 'fake-answer');

  sender1.send({ type: 'ice', sdp: { candidate: 'c1' } });
  const rIce = await receiver.waitFor((m) => m.type === 'ice');
  check('receiver receives ICE candidate', rIce.sdp && rIce.sdp.candidate === 'c1');

  receiver.send({ type: 'ice', sdp: { candidate: 'c2' } });
  const sIce = await sender1.waitFor((m) => m.type === 'ice');
  check('sender receives ICE candidate', sIce.sdp && sIce.sdp.candidate === 'c2');

  // 5. Second sender takes over the busy receiver.
  const sender2 = new Client('sender2');
  await new Promise((r) => sender2.ws.on('open', r));
  sender2.send({ type: 'hello', role: 'sender', deviceName: 'Bob PC' });
  const s2Ack = await sender2.waitFor((m) => m.type === 'hello_ack');
  const ourReceiverBusy = (s2Ack.receivers || []).find((r) => r.id === receiverId);
  check('second sender sees receiver marked busy', ourReceiverBusy && ourReceiverBusy.busy === true);

  sender2.send({ type: 'connect', receiverId });
  const s2Conn = await sender2.waitFor((m) => m.type === 'connected');
  check('second sender connects to busy receiver', s2Conn.receiver.id === receiverId);

  const s1Kicked = await sender1.waitFor((m) => m.type === 'disconnected');
  check('first sender is kicked (reason=switched)', s1Kicked.reason === 'switched');

  const rSwitch = await receiver.waitFor((m) => m.type === 'sender_connected' && m.sender.deviceName === 'Bob PC');
  check('receiver switched to new sender', rSwitch.sender.deviceName === 'Bob PC');

  // 6. Receiver leaves -> sender2 is notified.
  receiver.close();
  const s2Disc = await sender2.waitFor((m) => m.type === 'disconnected');
  check('sender notified when receiver leaves', s2Disc.reason === 'left');

  // 7. Sender leaves -> no crash, receiver list updates for remaining senders.
  sender2.close();
  await new Promise((r) => setTimeout(r, 300));
  sender1.close();

  console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Test error:', err.message);
  process.exit(1);
});

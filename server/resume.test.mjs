// A server restart (Fly trial cutoff, deploy, maintenance) wipes the in-memory rooms. A client that was in a room
// reconnects with resume:true and the server re-creates the room under the same code. Run: node resume.test.mjs
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from './index.js';
import { encode, decode, PROTOCOL_VERSION } from '../src/net/protocol.js';

const port = 9400 + Math.floor(Math.random() * 400);
const quiet = () => {};
const url = `ws://127.0.0.1:${port}`;
function hello(fields) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error('timeout')), 4000);
    ws.on('open', () => ws.send(encode('hello', { name: 'T', v: PROTOCOL_VERSION, ...fields })));
    ws.on('message', (raw) => {
      const m = decode(String(raw));
      if (m && (m.t === 'welcome' || m.t === 'error')) {
        clearTimeout(t);
        resolve({ ws, m });
      }
    });
    ws.on('error', reject);
  });
}
let srv = await startServer({ port, log: quiet });
const a = await hello({ difficulty: 'medium', timeHours: 30 });
assert.equal(a.m.t, 'welcome');
const code = a.m.room;
// restart: the room is gone
a.ws.close();
await srv.close();
srv = await startServer({ port, log: quiet });
const b = await hello({ room: code, resume: true, difficulty: 'medium', timeHours: 31 });
assert.equal(b.m.t, 'welcome', 'resume re-creates the lost room');
assert.equal(b.m.room, code, 'same room code after the restart');
assert.equal(b.m.isHost, true, 'the first player back is the host');
const c = await hello({ room: code });
assert.equal(c.m.t, 'welcome', 'a friend rejoins the resumed room by code');
assert.equal(c.m.isHost, false);
const d = await hello({ room: 'ABCDEF' === code ? 'GHJKLM' : 'ABCDEF' });
assert.equal(d.m.t, 'error', 'an unknown code without resume still fails');
for (const x of [b, c, d]) x.ws.close();
await srv.close();
console.log('resume: 5 checks passed');
process.exit(0);

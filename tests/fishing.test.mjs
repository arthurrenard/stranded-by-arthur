// V4-C: fishing state machine (pure) + HUD zone layout math. Run: node tests/fishing.test.mjs
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import * as L from '../src/gameplay/fishing-logic.js';

const F = CONFIG.fishing;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
/** Deterministic rng from a list (cycles). */
const seq = (vals) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};
const run = (logic, seconds, input, dt = 1 / 60) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) logic.tick(dt, input);
};
const drain = (logic) => logic.state.events.splice(0);

// ── loot table ─────────────────────────────────────────────────────────────
assert.ok(near(L.lootSum(F.loot), 1, 1e-9), `CONFIG.fishing.loot sums to 1 (${L.lootSum(F.loot)})`);
{
  const ids = Object.keys(F.loot);
  const seen = new Set();
  for (let r = 0; r < 1; r += 0.001) seen.add(L.pickLoot(F.loot, r));
  for (const id of ids) assert.ok(seen.has(id), `pickLoot reaches ${id}`);
  assert.equal(L.pickLoot(F.loot, 0), ids[0]);
  assert.equal(L.pickLoot(F.loot, 0.999999), ids[ids.length - 1], 'rounding falls on the last entry');
  assert.equal(L.pickLoot({}, 0.5), null);
  assert.ok(L.isFish('big_fish') && L.isFish('raw_fish') && L.isFish('crab'));
  assert.ok(L.isJunk('old_boot') && L.isJunk('rope') && L.isJunk('message'));
}

// ── timings ────────────────────────────────────────────────────────────────
{
  const [a, b] = F.fightDurationSec;
  assert.ok(near(L.fightDuration(F, 'big_fish'), b), 'the biggest fish fights the longest');
  assert.ok(L.fightDuration(F, 'old_boot') < L.fightDuration(F, 'crab'), 'junk < crab');
  assert.ok(L.fightDuration(F, 'crab') < L.fightDuration(F, 'raw_fish'), 'crab < reef fish');
  assert.ok(L.fightDuration(F, 'raw_fish') < L.fightDuration(F, 'big_fish'), 'reef fish < yellowfin');
  assert.ok(L.fightDuration(F, 'old_boot') >= a, 'never shorter than the minimum');
  assert.ok(near(L.biteDelay(F, 0), F.biteMinSec) && near(L.biteDelay(F, 0.999999), F.biteMinSec + (F.biteMaxSec - F.biteMinSec) * 0.999999));
  assert.ok(F.biteMinSec >= 20 && F.biteMaxSec <= 45, 'bite window 20–45 s per the spec');
  let seed = 12345; // deterministic: CI must never flake
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 200; k++) {
    const rng = seq([rand(), rand(), rand(), rand()]);
    const n = L.nibbleTimes(30, rng);
    assert.ok(n.length >= 1 && n.length <= 3, 'one to three nibbles');
    for (let i = 0; i < n.length; i++) {
      assert.ok(n[i] > 30 * 0.25 - 1e-9 && n[i] <= 30 * 0.85 + 1e-9, `nibble ${n[i]} inside the waiting window`);
      if (i) assert.ok(n[i] - n[i - 1] >= 1.5 - 1e-9, 'nibbles ≥ 1.5 s apart');
    }
  }
}

// ── the whole machine ──────────────────────────────────────────────────────
function make(rngVals = [0.3]) {
  return L.createFishingLogic(F, seq(rngVals));
}
{
  // cast → fly → nibbles → bite → nobody hooks → gone → idle
  const lg = make([0.0, 0.5, 0.5, 0.2, 0.5, 0.5, 0.5]); // loot r=0 (raw_fish), bottle r (skipped: fish), bite r=0.5 …
  assert.equal(lg.state.phase, 'idle');
  assert.ok(lg.cast());
  assert.ok(!lg.cast(), 'no double cast');
  assert.equal(lg.state.phase, 'waiting');
  assert.equal(lg.state.loot, 'raw_fish');
  assert.ok(lg.state.flying);
  assert.ok(lg.state.biteAt >= F.biteMinSec && lg.state.biteAt <= F.biteMaxSec, 'bite within bounds');
  assert.deepEqual(drain(lg), ['cast']);
  run(lg, 0.3);
  assert.ok(lg.state.flying, 'still in the air');
  assert.ok(!lg.reel(), 'reel during the flight does nothing');
  run(lg, 0.4);
  assert.ok(!lg.state.flying);
  assert.deepEqual(drain(lg), ['plop']);
  run(lg, lg.state.biteAt - 0.7 - 0.05);
  const ev = drain(lg);
  const nibbles = ev.filter((e) => e === 'nibble').length;
  assert.ok(nibbles >= 1 && nibbles <= 3, `nibbles before the bite (${nibbles})`);
  assert.ok(!ev.includes('bite'), 'no bite yet');
  assert.equal(lg.state.phase, 'waiting');
  run(lg, 0.1);
  assert.equal(lg.state.phase, 'bite');
  assert.deepEqual(drain(lg), ['bite']);
  assert.ok(near(lg.state.timeLeft, F.hookWindowSec, 0.05), 'hook window shown as time left');
  run(lg, F.hookWindowSec + 0.05);
  assert.equal(lg.state.phase, 'lost');
  assert.equal(lg.state.result.reason, 'gone');
  assert.deepEqual(drain(lg), ['lost']);
  run(lg, L.RESULT_SEC + 0.05);
  assert.equal(lg.state.phase, 'idle');
  assert.deepEqual(drain(lg), ['idle']);
}
{
  // reel while waiting = too early (nibbles are false alarms)
  const lg = make([0.0, 0.5, 0.5, 0.5]);
  lg.cast();
  run(lg, 2);
  lg.tick(1 / 60, { reel: true });
  assert.equal(lg.state.phase, 'lost');
  assert.equal(lg.state.result.reason, 'early');
}
{
  // hook within the window → fight; the fight ends by timeout when nobody reels
  const lg = make([0.0, 0.5, 0.0, 0.5, 0.5]); // raw_fish, bite at biteMinSec
  lg.cast();
  run(lg, lg.state.biteAt + 0.1);
  assert.equal(lg.state.phase, 'bite');
  run(lg, 1.0);
  lg.tick(1 / 60, { reel: true });
  assert.equal(lg.state.phase, 'fight');
  assert.ok(lg.state.events.includes('hooked'));
  drain(lg);
  const dur = L.fightDuration(F, 'raw_fish');
  assert.ok(near(lg.state.timeLeft, dur, 0.02), 'fight timer = fight duration');
  assert.equal(lg.state.progress, L.HOOK_PROGRESS);
  run(lg, dur / 2);
  assert.ok(lg.state.timeLeft > 0 && lg.state.progress < L.HOOK_PROGRESS, 'progress drains without taps');
  assert.ok(drain(lg).includes('run'), 'the fish ran at least once');
  run(lg, dur / 2 + 0.1);
  assert.equal(lg.state.phase, 'lost');
  assert.equal(lg.state.result.reason, 'escaped');
  assert.equal(lg.state.timeLeft, 0);
}
{
  // progress math: steady taps land the fish; tension relaxes between taps
  const lg = make([0.0, 0.5, 0.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  lg.cast();
  run(lg, lg.state.biteAt + 0.1);
  lg.tick(1 / 60, { reel: true });
  drain(lg);
  let taps = 0, maxTension = 0;
  while (lg.state.phase === 'fight' && taps < 100) {
    lg.tick(1 / 60, { reel: true });
    taps++;
    maxTension = Math.max(maxTension, lg.state.tension);
    run(lg, 0.45); // ~2 taps a second: tension relaxes (0.17 per tap vs 0.5/s)
  }
  assert.equal(lg.state.phase, 'landed', `landed after ${taps} taps`);
  assert.equal(lg.state.result.reason, 'landed');
  assert.equal(lg.state.result.loot, 'raw_fish');
  assert.ok(maxTension < 1, 'tension never reached 1 at a calm pace');
  assert.ok(taps >= 8 && taps <= 40, `a reasonable number of taps (${taps})`);
  assert.ok(lg.state.events.includes('landed'));
  run(lg, L.RESULT_SEC + 0.05);
  assert.equal(lg.state.phase, 'idle');
}
{
  // tension snap: hammering the key breaks the line; rod loss only on the big fish and only with the 15 % roll
  const snapTest = (lootR, rodR) => {
    let k = 0;
    const lg = L.createFishingLogic(F, () => (k++ === 0 ? lootR : rodR)); // first roll = loot, every later roll = rodR
    lg.cast();
    run(lg, lg.state.biteAt + 0.1);
    lg.tick(1 / 60, { reel: true });
    let taps = 0;
    while (lg.state.phase === 'fight' && taps < 50) {
      lg.tick(1 / 120, { reel: true });
      taps++;
    }
    assert.equal(lg.state.phase, 'lost', 'hammering snaps the line');
    assert.equal(lg.state.result.reason, 'snap');
    assert.equal(lg.state.tension, 1);
    assert.ok(taps <= Math.ceil(1 / F.tensionPerTap) + 1, `snapped within ${taps} taps`);
    return lg.state.result;
  };
  const big = 0.5 + 0.001; // raw_fish 0.5, big_fish next 0.14
  assert.equal(snapTest(big, 0.1).loot, null, 'nothing landed on a snap');
  const lg1 = make([big, 0.9, 0, 0.5, 0.5, 0.5, 0.1]);
  lg1.cast();
  assert.equal(lg1.state.loot, 'big_fish');
  assert.ok(snapTest(big, 0.1).rodLost, '15 % roll (r=0.1) loses the rod on a yellowfin');
  assert.ok(!snapTest(big, 0.5).rodLost, 'r=0.5 keeps the rod');
  assert.ok(!snapTest(0.0, 0.1).rodLost, 'a reef fish never takes the rod');
}
{
  // movement / cancel / lore bottle
  const lg = make([0.0, 0.5, 0.5, 0.5]);
  lg.cast();
  run(lg, 1);
  lg.tick(1 / 60, { moved: true });
  assert.equal(lg.state.phase, 'lost');
  assert.equal(lg.state.result.reason, 'moved');
  run(lg, L.RESULT_SEC + 0.1);
  assert.equal(lg.state.phase, 'idle');
  lg.cast();
  assert.ok(lg.cancel('cancel'));
  assert.equal(lg.state.result.reason, 'cancel');
  assert.ok(!lg.cancel(), 'cancel is idempotent on a finished cast');
  // junk + bottle roll < BOTTLE_CHANCE → the lore bottle
  const lb = make([0.9, 0.01, 0.5, 0.5]); // r=0.9 → junk (old_boot/rope/cloth/plank zone)
  lb.cast();
  assert.equal(lb.state.loot, L.BOTTLE_ID, 'rare lore bottle replaces a junk catch');
  const lj = make([0.9, 0.5, 0.5, 0.5]);
  lj.cast();
  assert.ok(L.isJunk(lj.state.loot) && lj.state.loot !== L.BOTTLE_ID, 'otherwise plain junk');
  const lf = make([0.0, 0.01, 0.5, 0.5]);
  lf.cast();
  assert.equal(lf.state.loot, 'raw_fish', 'a fish is never swapped for a bottle');
}
{
  // no per-frame allocation: events array is reused (host sets length = 0)
  const lg = make([0.0, 0.5, 0.5]);
  lg.cast();
  const arr = lg.state.events;
  arr.length = 0;
  run(lg, 2);
  assert.equal(lg.state.events, arr, 'same events array');
  assert.ok(lg.active);
}

console.log('fishing logic ok');

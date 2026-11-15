// Pure co-op raft logic (V5-B, SPEC §13): seats and pose interpolation for the shared 2-seat paddle raft.
// No THREE, no DOM: unit-tested by tests/coop.test.mjs. vehicles.js does the rest.
//
// Seats: an array [seat0, seat1] of occupants (null = free). Seat 0 paddles (drives), seat 1 rides along.
// The local player is stored as the ME sentinel (so a reconnect with a new net id changes nothing locally);
// remote players by their net id. The simulator of a raft is its seat-0 occupant, else its owner.

export const ME = '@me';
export const SEATS = 2;

export const makeSeats = () => [null, null];

/** The free seat a boarding player takes (0 first), or -1 when the raft is full. */
export function freeSeat(seats) {
  for (let i = 0; i < SEATS; i++) if (seats[i] == null) return i;
  return -1;
}

/** Index of `who`'s seat, or -1. */
export const seatOf = (seats, who) => (who == null ? -1 : seats.indexOf(who));

/** Empty every seat `who` holds. Returns the freed seat indices. */
export function releaseSeats(seats, who) {
  const out = [];
  for (let i = 0; i < SEATS; i++) {
    if (seats[i] === who) {
      seats[i] = null;
      out.push(i);
    }
  }
  return out;
}

/** Drop every remote occupant (going offline). Returns true when anything changed. */
export function clearRemote(seats) {
  let ch = false;
  for (let i = 0; i < SEATS; i++) {
    if (seats[i] != null && seats[i] !== ME) {
      seats[i] = null;
      ch = true;
    }
  }
  return ch;
}

/**
 * Apply a remote vehicle:seat message: `from` takes `seat`, or frees it when `occupant` is null.
 * `from` is the relay sender (the authoritative identity), `occupant` the payload's playerId (null = leaving).
 * Simultaneous claims of the same seat are settled by id: the lower id keeps it. Returns:
 *   'ok'      the claim was applied (or was a no-op)
 *   'kept'    the seat is ours and we win the tie: the claim is ignored (the claimer will yield on our re-announce)
 *   'yield'   the seat was ours and we lose: the caller must move us (another free seat) or drop us off
 */
export function applySeatClaim(seats, seat, from, occupant, myId) {
  if (!(seat === 0 || seat === 1) || from == null) return 'ok';
  if (occupant == null) {
    // leaving: only the occupant itself may free its seat
    if (seats[seat] === from) seats[seat] = null;
    return 'ok';
  }
  // a player sits in one seat at a time
  for (let i = 0; i < SEATS; i++) if (i !== seat && seats[i] === from) seats[i] = null;
  const cur = seats[seat];
  if (cur === ME) {
    if (myId != null && String(myId) < String(from)) return 'kept';
    seats[seat] = from;
    return 'yield';
  }
  seats[seat] = from;
  return 'ok';
}

/** Who simulates (and broadcasts) a raft: the seat-0 occupant, else the owner (ME for our own raft). */
export const simulatorOf = (seats, owner) => (seats[0] != null ? seats[0] : owner);

// ── Pose interpolation ────────────────────────────────────────────────────
const TAU = Math.PI * 2;
export function angleLerp(a, b, k) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * k;
}

/**
 * A small ring buffer of timestamped poses (seconds). push() takes plain numbers (no allocation after creation);
 * sample(t, out) writes the pose at time t (linear between the bracketing samples, heading by the short way),
 * holding the newest pose (no extrapolation) once t passes it and the oldest before it. Returns false when empty.
 */
export function createPoseBuffer(n = 6) {
  const T = new Float64Array(n), X = new Float64Array(n), Z = new Float64Array(n), Hd = new Float64Array(n), R = new Float64Array(n);
  const C = new Uint8Array(n);
  let len = 0, head = 0; // head = index of the next write
  const at = (i) => (head - len + i + n * 2) % n; // i-th oldest
  return {
    get length() {
      return len;
    },
    clear() {
      len = 0;
      head = 0;
    },
    push(t, x, z, heading, roll = 0, cap = 0) {
      if (len > 0 && t < T[at(len - 1)]) return false; // out of order
      T[head] = t;
      X[head] = x;
      Z[head] = z;
      Hd[head] = heading;
      R[head] = roll;
      C[head] = cap ? 1 : 0;
      head = (head + 1) % n;
      if (len < n) len++;
      return true;
    },
    /** Newest sample time (or -Infinity). */
    latest() {
      return len ? T[at(len - 1)] : -Infinity;
    },
    sample(t, out) {
      if (!len) return false;
      let j = at(len - 1);
      if (len === 1 || t >= T[j]) return write(out, j, j, 0);
      let i = at(0);
      if (t <= T[i]) return write(out, i, i, 0);
      for (let k = len - 2; k >= 0; k--) {
        i = at(k);
        if (T[i] <= t) {
          j = at(k + 1);
          const span = T[j] - T[i];
          return write(out, i, j, span > 1e-9 ? (t - T[i]) / span : 1);
        }
      }
      return write(out, j, j, 0);
    },
  };
  function write(out, i, j, k) {
    out.x = X[i] + (X[j] - X[i]) * k;
    out.z = Z[i] + (Z[j] - Z[i]) * k;
    out.heading = angleLerp(Hd[i], Hd[j], k);
    out.roll = R[i] + (R[j] - R[i]) * k;
    out.cap = k < 0.5 ? C[i] : C[j];
    return true;
  }
}

/** True when the driver should send a pose now: ≥ 1/hz since the last one and moved, or a 1 s heartbeat. */
export function poseDue(sinceLast, moved, hz = 10) {
  if (sinceLast < 1 / hz) return false;
  return moved || sinceLast >= 1;
}

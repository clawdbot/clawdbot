// Real-timer behavior proof for createTypingCallbacks (issue #116695).
// Uses REAL wall-clock setTimeout (no fake timers) to demonstrate the
// idle-TTL slide + absolute ceiling with compressed millisecond durations
// so the observable timeline mirrors a real long agent turn.
//
// Run: node scripts/typing-realtime-proof.mjs
// (Requires the package built to dist, or run via tsx/vitest env.)

import { createTypingCallbacks } from "../src/channels/typing.ts";

const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(4, " ")}ms`;
const log = (...a) => console.log(stamp(), ...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(name, run) {
  console.log(`\n=== ${name} ===`);
  await run();
}

// Scenario A: healthy long turn — keepalive keeps sliding idle TTL, typing stays alive
await scenario("A: healthy long turn keeps typing alive past idle TTL", async () => {
  let starts = 0;
  let stopped = false;
  const cb = createTypingCallbacks({
    start: async () => {
      starts += 1;
      log(`start() #${starts} (channel typing action sent)`);
    },
    stop: async () => {
      stopped = true;
      log("stop() (typing indicator torn down)");
    },
    onStartError: (e) => log("start error", e),
    keepaliveIntervalMs: 40, // real 40ms keepalive cadence
    maxDurationMs: 120, // idle TTL: 120ms of quiet -> stop
    absoluteMaxDurationMs: 5000,
  });
  await cb.onReplyStart();
  // Run 400ms — well past the 120ms idle TTL. Healthy keepalives should slide it.
  await sleep(400);
  log(`after 400ms healthy turn: starts=${starts} stopped=${stopped}`);
  if (stopped) throw new Error("FAIL: healthy turn stopped early");
  if (starts < 5) throw new Error("FAIL: keepalive did not tick");
  cb.onCleanup?.();
  await sleep(20);
  log("PASS: healthy long turn stayed alive; clean teardown on cleanup");
});

// Scenario B: channel goes quiet — start() fails, idle TTL fires and stops
await scenario("B: quiet/failing channel hits idle TTL and stops", async () => {
  let stopped = false;
  const cb = createTypingCallbacks({
    start: async () => {
      throw new Error("channel unavailable");
    },
    stop: async () => {
      stopped = true;
      log("stop() (idle TTL teardown)");
    },
    onStartError: () => {},
    keepaliveIntervalMs: 40,
    maxDurationMs: 120,
    maxConsecutiveFailures: 2,
    absoluteMaxDurationMs: 5000,
  });
  await cb.onReplyStart();
  await sleep(300);
  log(`after 300ms failing channel: stopped=${stopped}`);
  cb.onCleanup?.();
});

// Scenario C: absolute ceiling fires even while start() keeps succeeding
await scenario("C: absolute ceiling stops runaway turn despite healthy keepalive", async () => {
  let stopped = false;
  let starts = 0;
  const cb = createTypingCallbacks({
    start: async () => {
      starts += 1;
    },
    stop: async () => {
      stopped = true;
      log(`ABSOLUTE ceiling fired -> stop() after ${starts} healthy starts`);
    },
    onStartError: () => {},
    keepaliveIntervalMs: 40,
    maxDurationMs: 500, // idle TTL longer than absolute so absolute wins
    absoluteMaxDurationMs: 200, // absolute ceiling: 200ms hard cap
  });
  await cb.onReplyStart();
  await sleep(400);
  log(`after 400ms: starts=${starts} stopped=${stopped}`);
  if (!stopped) throw new Error("FAIL: absolute ceiling never fired");
  cb.onCleanup?.();
  log("PASS: absolute ceiling enforced despite sliding idle TTL");
});

console.log("\nAll real-timer scenarios completed.");

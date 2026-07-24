#!/usr/bin/env node
/**
 * Live Slack Socket Mode transport-liveness proof (redacted output).
 *
 * Env:
 *   SLACK_BOT_TOKEN=xoxb-...
 *   SLACK_APP_TOKEN=xapp-...
 *   PROOF_QUIET_MS=45000   (default)
 *   PROOF_IDLE_MS=15000    (default; must be < quiet window)
 *
 * Run:
 *   node --import tsx scripts/live-slack-transport-proof.mjs
 *
 * Proof:
 *   A) Quiet keepalive produces transport activity marks (owned ws ping/pong)
 *   B) Disconnect waiter armed with idleTimeoutMs does NOT fire during quiet
 *      because live Slack keepalive resets the idle window
 *   C) Same waiter fires transport_idle when no transport frames arrive
 */
const bot = process.env.SLACK_BOT_TOKEN || "";
const appToken = process.env.SLACK_APP_TOKEN || "";
if (!bot.startsWith("xoxb-") || !appToken.startsWith("xapp-")) {
  console.error("Need SLACK_BOT_TOKEN (xoxb-) and SLACK_APP_TOKEN (xapp-) in env");
  process.exit(2);
}

function redactToken(t) {
  return `${t.slice(0, 8)}… len=${t.length}`;
}

const quietMs = Number(process.env.PROOF_QUIET_MS || 45_000);
const idleMs = Number(process.env.PROOF_IDLE_MS || 15_000);
if (!(idleMs > 0) || !(quietMs > idleMs * 2)) {
  console.error("PROOF_QUIET_MS must be > 2 * PROOF_IDLE_MS");
  process.exit(2);
}

console.log("=== Slack Socket Mode transport proof (redacted) ===");
console.log("bot", redactToken(bot));
console.log("app", redactToken(appToken));
console.log("quietMs", quietMs, "idleMs", idleMs);

const reconnect = await import(
  new URL("../extensions/slack/src/monitor/reconnect-policy.ts", import.meta.url).href
);
const { registerSlackSocketModeTransportActivity, waitForSlackSocketDisconnect } = reconnect;

const { App } = await import("@slack/bolt");
const app = new App({
  token: bot,
  appToken,
  socketMode: true,
});

const transportMarks = [];
let lastAt = 0;
const unregister = registerSlackSocketModeTransportActivity({
  app,
  onTransportActivity: (at) => {
    const delta = lastAt ? at - lastAt : 0;
    lastAt = at;
    transportMarks.push({ at, deltaMs: delta });
    if (transportMarks.length <= 8 || transportMarks.length % 10 === 0) {
      console.log(
        `[transport] mark#${transportMarks.length} at=${new Date(at).toISOString()} deltaMs=${delta}`,
      );
    }
  },
});

console.log("starting socket mode…");
await app.start();
console.log(
  "started; owned websocket readyState=",
  app.receiver?.client?.websocket?.websocket?.readyState,
);

const abort = new AbortController();
let idleEarly = null;
const liveWaiter = waitForSlackSocketDisconnect(app, abort.signal, { idleTimeoutMs: idleMs }).then(
  (result) => {
    idleEarly = result;
    return result;
  },
);

console.log(
  `observing quiet keepalive for ${quietMs}ms with idleTimeoutMs=${idleMs} (must NOT fire)…`,
);
await new Promise((r) => setTimeout(r, quietMs));

const quietMarks = transportMarks.length;
console.log(`[quiet] transport marks during quiet window: ${quietMarks}`);
if (quietMarks < 5) {
  console.error("FAIL A: expected repeated transport activity during quiet keepalive window");
  abort.abort();
  unregister();
  await app.stop().catch(() => {});
  process.exit(1);
}
console.log("PASS A: quiet keepalive produced repeated transport activity without app inbound");

if (idleEarly) {
  console.error("FAIL B: idle waiter fired early during live keepalive:", idleEarly.event);
  unregister();
  await app.stop().catch(() => {});
  process.exit(1);
}
console.log(
  "PASS B: idle waiter did not fire during quiet window (keepalive reset the bounded idle timer)",
);
abort.abort();
await liveWaiter.catch(() => {});

unregister();
class SilentEmitter {
  constructor() {
    this.m = new Map();
  }
  on(e, l) {
    const s = this.m.get(e) ?? new Set();
    s.add(l);
    this.m.set(e, s);
  }
  off(e, l) {
    this.m.get(e)?.delete(l);
  }
}
const silentApp = { receiver: { client: new SilentEmitter() } };
console.log(`arming waiter on silent client with idleTimeoutMs=${Math.min(idleMs, 3000)}…`);
const silentIdle = await waitForSlackSocketDisconnect(silentApp, undefined, {
  idleTimeoutMs: Math.min(idleMs, 3000),
});
console.log("[idle] silent waiter result:", silentIdle.event);
if (silentIdle.event !== "transport_idle") {
  console.error("FAIL C: expected transport_idle on silent client");
  await app.stop().catch(() => {});
  process.exit(1);
}
console.log("PASS C: bounded idle waiter fires transport_idle when no transport frames arrive");

await app.stop().catch(() => {});
console.log("=== proof complete ===");
console.log(
  JSON.stringify(
    {
      quietWindowMs: quietMs,
      idleTimeoutMs: idleMs,
      transportMarksInQuietWindow: quietMarks,
      firstMarkIso: new Date(transportMarks[0].at).toISOString(),
      lastMarkIso: new Date(transportMarks.at(-1).at).toISOString(),
      liveIdleFiredDuringQuiet: false,
      silentIdleResult: silentIdle.event,
      keepaliveSource: "owned ws ping/pong (+ connect/ws_message)",
    },
    null,
    2,
  ),
);
process.exit(0);

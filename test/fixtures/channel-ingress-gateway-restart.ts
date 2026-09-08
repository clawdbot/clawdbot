import path from "node:path";
import { createStandardRawEventIngressMonitor } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelIngressQueue } from "../../src/channels/message/ingress-queue.js";
import { runGatewayLoop } from "../../src/cli/gateway-cli/run-loop.js";
import type { GatewayServer } from "../../src/gateway/server-public.js";
import {
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
} from "../../src/infra/restart.js";
import {
  getGatewayRestartDrainSignal,
  resetGatewayWorkAdmission,
} from "../../src/process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";

const stateDir = process.argv[2];
if (!stateDir) {
  throw new Error("state directory argument is required");
}
process.env.OPENCLAW_STATE_DIR = path.resolve(stateDir);
process.env.OPENCLAW_NO_RESPAWN = "1";
resetGatewayWorkAdmission();
resetGatewayRestartStateForInProcessRestart();

let releaseFirstClose = () => {};
const firstCloseGate = new Promise<void>((resolve) => {
  releaseFirstClose = resolve;
});
let markFirstStart = () => {};
const firstStarted = new Promise<void>((resolve) => {
  markFirstStart = resolve;
});
let markSecondStart = () => {};
const secondStarted = new Promise<void>((resolve) => {
  markSecondStart = resolve;
});
let markExited = (_code: number) => {};
const exited = new Promise<number>((resolve) => {
  markExited = resolve;
});
let startCount = 0;

void runGatewayLoop({
  ownsProcessLifecycle: false,
  lockPort: 20_000 + (process.pid % 20_000),
  runtime: {
    log: () => {},
    error: () => {},
    exit: markExited,
  },
  start: async () => {
    startCount += 1;
    if (startCount === 1) {
      markFirstStart();
    } else {
      markSecondStart();
    }
    const thisStart = startCount;
    return {
      startupSettled: Promise.resolve(),
      getTailscaleIngressEndpoint: () => undefined,
      close: async () => {
        if (thisStart === 1) {
          await firstCloseGate;
        }
      },
    } satisfies GatewayServer;
  },
});

await firstStarted;

type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };
const queue = createChannelIngressQueue<StoredEvent>({
  channelId: "test",
  accountId: "gateway-restart",
  stateDir,
});
let releasePrune = (_error?: Error) => {};
const pruneGate = new Promise<void>((resolve, reject) => {
  releasePrune = (error) => (error ? reject(error) : resolve());
});
let markPruneStarted = () => {};
const pruneStarted = new Promise<void>((resolve) => {
  markPruneStarted = resolve;
});
const prune = queue.prune.bind(queue);
queue.prune = async (...args) => {
  markPruneStarted();
  await pruneGate;
  return await prune(...args);
};
const activity: boolean[] = [];
const ingress = createStandardRawEventIngressMonitor<
  RawEvent,
  unknown,
  { eventId: string; laneKey: string }
>({
  queue,
  inspect: (raw: RawEvent) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
  payload: {
    serialize: (raw) => JSON.stringify(raw),
    deserialize: (body) => JSON.parse(body) as RawEvent,
    createClaimError: (kind) => new Error(kind),
  },
  deliver: async () => {},
  pollIntervalMs: 60_000,
  drain: {
    adoptionStallTimeoutMs: 5_000,
    retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
    resolveNonRetryableFailure: () => null,
  },
  classifyAdmissionError: () => undefined,
  onActivityChange: (active) => activity.push(active),
});

ingress.start();
await pruneStarted;
await ingress.receive({ id: "event-restart", lane: "a", text: "queued before restart" });
const restart = requestGatewayRestartWithSignalAdmission("test", {
  force: true,
  reason: "test",
});
if (restart.status !== "emitted") {
  throw new Error(`restart was not emitted: ${restart.status}`);
}
while (!getGatewayRestartDrainSignal().aborted) {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
process.send?.({ type: "ingress-restart-drain-committed" });

releasePrune(new Error("restart drain interrupted prune"));
const idleStartedAt = Date.now();
await ingress.waitForIdle();
const idleMs = Date.now() - idleStartedAt;
const finalActivity = activity.at(-1);

await ingress.stop();
releaseFirstClose();
await secondStarted;
process.emit("SIGINT");
const exitCode = await exited;
closeOpenClawStateDatabaseForTest();

process.send?.({
  type: "ingress-restart-proof",
  proof: {
    restart: restart.status,
    committed: true,
    idleMs,
    finalActivity,
    exitCode,
  },
});
process.exit(0);

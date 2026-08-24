import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempTelegramHeartbeatSandbox,
} from "../infra/heartbeat-runner.test-utils.js";
import { selectAgentSystemEvents } from "../infra/system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { startDeferredNotifyRun } from "./bash-tools.notify-on-exit-ack.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";

const requestHeartbeatMock = vi.hoisted(() => vi.fn());
const supervisorSpawnMock = vi.hoisted(() => vi.fn());
const randomMock = vi.hoisted(() => vi.fn(() => 0));

vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-wake.js")>()),
  requestHeartbeat: requestHeartbeatMock,
}));
vi.mock("../infra/secure-random.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/secure-random.js")>()),
  generateSecureInt: randomMock,
}));
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: supervisorSpawnMock, getRecord: vi.fn() }),
}));

const QUEUE_KEY = "agent:main:notify-ack";
const startNotifyRun = () =>
  startDeferredNotifyRun({
    spawn: supervisorSpawnMock,
    sessionKey: QUEUE_KEY,
    notifyDeliveryContext: { channel: "telegram", to: "-100123", threadId: 42 },
  });
const processTool = createProcessTool();
const execute = (action: "poll" | "clear", sessionId: string) =>
  processTool.execute(`${action}-${sessionId}`, { action, sessionId });
const poll = (sessionId: string) => execute("poll", sessionId);
const contexts = () => peekSystemEventEntries(QUEUE_KEY).map((event) => event.contextKey);

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
});
afterEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it("keeps selected-agent global completions scoped to their owner", async () => {
  const process = await startDeferredNotifyRun({
    spawn: supervisorSpawnMock,
    sessionKey: "global",
    agentId: "research",
  });
  await process.finish();

  expect(requestHeartbeatMock).toHaveBeenCalledWith({
    source: "exec-event",
    intent: "event",
    reason: "exec-event",
    coalesceMs: 0,
    agentId: "research",
  });
  const queued = peekSystemEventEntries("global");
  expect(selectAgentSystemEvents(queued, "research")).toHaveLength(1);
  expect(selectAgentSystemEvents(queued, "main")).toEqual([]);
});

it("isolates identical completions across exact full-slug reuse", async () => {
  const first = await startNotifyRun();
  await first.finish();
  await execute("clear", first.run.session.id);
  enqueueSystemEventEntry("unrelated", { sessionKey: QUEUE_KEY, contextKey: "marker" });
  const second = await startNotifyRun();
  await second.finish();

  expect([first.run.session.id, second.run.session.id]).toEqual(["amber-atlas", "amber-atlas"]);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker", "exec:amber-atlas"]);
  const queued = peekSystemEventEntries(QUEUE_KEY);
  expect(queued[0]?.id).not.toBe(queued[2]?.id);
  expect(queued[0]).toEqual({ ...queued[2], id: queued[0]?.id });

  await poll(second.run.session.id);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker"]);
  await poll(second.run.session.id);
  expect(contexts()).toEqual(["exec:amber-atlas", "marker"]);
});

it("invalidates a heartbeat snapshot when terminal poll consumes its occurrence", async () => {
  const process = await startNotifyRun();
  await process.finish();
  const snapshot = peekSystemEventEntries(QUEUE_KEY);
  await poll(process.run.session.id);

  expect(peekSystemEventEntries(QUEUE_KEY)).toEqual([]);
  expect(consumeSelectedSystemEventEntries(QUEUE_KEY, snapshot)).toEqual([]);
});

it("keeps an identical successor queued when heartbeat consumes a stale snapshot", async () => {
  await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", target: "telegram" },
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { mainKey: "notify-ack", store: storePath },
    };
    const sessionKey = await seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100123",
      lastThreadId: 42,
    });
    expect(sessionKey).toBe(QUEUE_KEY);

    const first = await startNotifyRun();
    await first.finish();
    const firstQueued = peekSystemEventEntries(QUEUE_KEY);
    expect(firstQueued).toHaveLength(1);

    let successor: Awaited<ReturnType<typeof startNotifyRun>> | undefined;
    replySpy.mockImplementation(async () => {
      await poll(first.run.session.id);
      await execute("clear", first.run.session.id);
      const replacement = await startNotifyRun();
      successor = replacement;
      await replacement.finish();
      const replacementQueued = peekSystemEventEntries(QUEUE_KEY);
      expect(replacementQueued).toHaveLength(1);
      expect(replacementQueued[0]?.id).not.toBe(firstQueued[0]?.id);
      expect(replacementQueued[0]).toEqual({ ...firstQueued[0], id: replacementQueued[0]?.id });
      return { text: "Handled the exec completion" };
    });
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "100123" });

    const result = await runHeartbeatOnce({
      cfg,
      agentId: "main",
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      deps: {
        getQueueSize: () => 0,
        getReplyFromConfig: replySpy,
        telegram: sendTelegram,
      },
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).toHaveBeenCalledOnce();
    if (!successor) {
      throw new Error("heartbeat reply did not enqueue the successor completion");
    }
    expect(successor.run.session.id).toBe(first.run.session.id);
    expect(peekSystemEventEntries(QUEUE_KEY)).toHaveLength(1);

    await poll(successor.run.session.id);
    expect(peekSystemEventEntries(QUEUE_KEY)).toEqual([]);
  });
});

it("keeps an unpolled completion deliverable after finished-session cleanup", async () => {
  const process = await startNotifyRun();
  await process.finish();
  await execute("clear", process.run.session.id);

  expect(contexts()).toEqual([`exec:${process.run.session.id}`]);
});

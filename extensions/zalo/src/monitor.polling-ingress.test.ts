// Zalo tests cover the durable ingress journal on the polling transport.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createEmptyPluginRegistry,
  createRuntimeEnv,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { ResolvedZaloAccount } from "./accounts.js";
import type { ZaloUpdate } from "./api.js";
import type { OpenClawConfig, PluginRuntime } from "./runtime-api.js";
import {
  createImageLifecycleCore,
  createLifecycleMonitorSetup,
  createTextUpdate,
  settleAsyncWork,
} from "./test-support/lifecycle-test-support.js";
import {
  getUpdatesMock,
  getZaloRuntimeMock,
  loadCachedLifecycleMonitorModule,
  resetLifecycleTestState,
} from "./test-support/monitor-mocks-test-support.js";
import {
  waitForZaloWebhookVerdict,
  type ZaloWebhookTestPayload,
} from "./webhook-spool.test-support.js";

type ZaloPollingTestQueue = Parameters<typeof waitForZaloWebhookVerdict>[0];

type DispatchReplyOptions = {
  replyOptions?: {
    turnAdoptionLifecycle?: { onAdopted: () => Promise<void> };
  };
};

function createDeferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function startPollingMonitor(setup: {
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
}) {
  const { monitorZaloProvider } = await loadCachedLifecycleMonitorModule("zalo-polling-ingress");
  const abort = new AbortController();
  const runtime = createRuntimeEnv();
  const run = monitorZaloProvider({
    token: "zalo-token", // pragma: allowlist secret
    account: setup.account,
    config: setup.config,
    runtime,
    abortSignal: abort.signal,
  });
  return { abort, run, runtime };
}

describe("Zalo polling durable ingress", () => {
  const { core } = createImageLifecycleCore();
  const dispatchMock = core.channel.reply
    .dispatchReplyWithBufferedBlockDispatcher as unknown as Mock;
  let stateDir: string | undefined;
  let queue: ZaloPollingTestQueue;

  beforeAll(async () => {
    // Install module mocks first, then warm the lazy ingress module so monitor
    // startup does not pay module load inside the tests.
    await loadCachedLifecycleMonitorModule("zalo-polling-ingress");
    await import("./webhook-spool.js");
  });

  beforeEach(async () => {
    await resetLifecycleTestState();
    const createdDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zalo-poll-ingress-"));
    stateDir = await fs.realpath(createdDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    queue = createChannelIngressQueueForTests<ZaloWebhookTestPayload>({
      channelId: "zalo",
      accountId: "default",
      stateDir,
    });
    core.state.openChannelIngressQueue = ((_options: { accountId?: string }) =>
      queue) as unknown as PluginRuntime["state"]["openChannelIngressQueue"];
    getZaloRuntimeMock.mockReturnValue(core);
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterAll(async () => {
    await resetLifecycleTestState();
  });

  afterEach(async () => {
    dispatchMock.mockReset();
    await resetLifecycleTestState();
    closeOpenClawStateDatabaseForTest();
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("journals a polled update durably before dispatch and tombstones it after adoption", async () => {
    const update = createTextUpdate({
      messageId: "poll-journal-1",
      userId: "user-1",
      userName: "User One",
      chatId: "dm-chat-1",
    });
    getUpdatesMock
      .mockResolvedValueOnce({ ok: true, result: update as ZaloUpdate })
      .mockImplementation(() => new Promise(() => {}));

    const dispatchStarted = createDeferred();
    const dispatchGate = createDeferred();
    let durableIdsAtDispatch: string[] = [];
    dispatchMock.mockImplementation(async ({ replyOptions }: DispatchReplyOptions) => {
      // The update must be durable before the agent turn starts.
      const [claims, pending] = await Promise.all([queue.listClaims(), queue.listPending()]);
      durableIdsAtDispatch = [...claims, ...pending].map((record) => record.id);
      dispatchStarted.resolve();
      await dispatchGate.promise;
      await replyOptions?.turnAdoptionLifecycle?.onAdopted();
    });

    const { abort, run } = await startPollingMonitor(
      createLifecycleMonitorSetup({ accountId: "default", dmPolicy: "open", webhookUrl: "" }),
    );

    await dispatchStarted.promise;
    expect(durableIdsAtDispatch).toEqual(["poll-journal-1"]);

    dispatchGate.resolve();
    await waitForZaloWebhookVerdict(queue, "poll-journal-1", "completed");
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    abort.abort();
    await run;
  });

  it("dedupes a re-polled update after completion", async () => {
    const update = createTextUpdate({
      messageId: "poll-dedupe-1",
      userId: "user-1",
      userName: "User One",
      chatId: "dm-chat-1",
    });
    dispatchMock.mockImplementation(async ({ replyOptions }: DispatchReplyOptions) => {
      await replyOptions?.turnAdoptionLifecycle?.onAdopted();
    });
    getUpdatesMock
      .mockResolvedValueOnce({ ok: true, result: update as ZaloUpdate })
      // Simulate a Bot API redelivery of the same consumed update.
      .mockResolvedValueOnce({ ok: true, result: update as ZaloUpdate })
      .mockImplementation(() => new Promise(() => {}));

    const { abort, run } = await startPollingMonitor(
      createLifecycleMonitorSetup({ accountId: "default", dmPolicy: "open", webhookUrl: "" }),
    );

    // Wait for the monitor's own admission before probing the row: the verdict
    // probe enqueues, so it must never win the race against the polled admission.
    await vi.waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });
    await waitForZaloWebhookVerdict(queue, "poll-dedupe-1", "completed");
    await vi.waitFor(() => {
      expect(getUpdatesMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    await settleAsyncWork();
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    abort.abort();
    await run;
  });

  it("replays a journaled update exactly once after a crash between poll and dispatch", async () => {
    const update = createTextUpdate({
      messageId: "poll-restart-1",
      userId: "user-1",
      userName: "User One",
      chatId: "dm-chat-1",
    });
    const dispatchStarted = createDeferred();
    const crashDispatch = createDeferred();
    // First attempt dies mid-dispatch: the process is killed before a verdict.
    dispatchMock.mockImplementationOnce(async () => {
      dispatchStarted.resolve();
      await crashDispatch.promise;
    });
    getUpdatesMock
      .mockResolvedValueOnce({ ok: true, result: update as ZaloUpdate })
      .mockImplementation(() => new Promise(() => {}));

    const setup = createLifecycleMonitorSetup({
      accountId: "default",
      dmPolicy: "open",
      webhookUrl: "",
    });
    const first = await startPollingMonitor(setup);

    await dispatchStarted.promise;
    // Crash while the delivery is in flight; the journaled row must survive the
    // stop either as a dead-owner claim or as a released retry.
    first.abort.abort();
    crashDispatch.reject(new Error("simulated process crash"));
    await first.run;

    const [crashClaims, crashPending] = await Promise.all([
      queue.listClaims(),
      queue.listPending(),
    ]);
    expect([...crashClaims, ...crashPending].map((record) => record.id)).toEqual([
      "poll-restart-1",
    ]);

    // Restart: a fresh monitor recovers the unfinished row and replays it.
    dispatchMock.mockImplementation(async ({ replyOptions }: DispatchReplyOptions) => {
      await replyOptions?.turnAdoptionLifecycle?.onAdopted();
    });
    getUpdatesMock.mockReset();
    getUpdatesMock
      // The Bot API re-serves the consumed update once more after the restart.
      .mockResolvedValueOnce({ ok: true, result: update as ZaloUpdate })
      .mockImplementation(() => new Promise(() => {}));

    const second = await startPollingMonitor(setup);

    await waitForZaloWebhookVerdict(queue, "poll-restart-1", "completed");
    await vi.waitFor(() => {
      expect(getUpdatesMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await settleAsyncWork();
    // Exactly one successful dispatch across crash + replay + redelivery.
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    second.abort.abort();
    await second.run;
  });

  it("journals a polled update on the abort path with durable-after-stop admission", async () => {
    const updateA = createTextUpdate({
      messageId: "poll-abort-a",
      userId: "user-1",
      userName: "User One",
      chatId: "dm-chat-1",
    });
    const updateB = createTextUpdate({
      messageId: "poll-abort-b",
      userId: "user-1",
      userName: "User One",
      chatId: "dm-chat-1",
    });

    // First update completes normally so the poll loop advances to the next
    // getUpdates call, which stays in-flight past shutdown.
    dispatchMock.mockImplementation(async ({ replyOptions }: DispatchReplyOptions) => {
      await replyOptions?.turnAdoptionLifecycle?.onAdopted();
    });

    const latePoll = createDeferred();
    getUpdatesMock
      .mockResolvedValueOnce({ ok: true, result: updateA as ZaloUpdate })
      .mockImplementationOnce(() =>
        latePoll.promise.then(() => ({ ok: true, result: updateB as ZaloUpdate })),
      )
      .mockImplementation(() => new Promise(() => {}));

    const { abort, run } = await startPollingMonitor(
      createLifecycleMonitorSetup({ accountId: "default", dmPolicy: "open", webhookUrl: "" }),
    );

    // Wait for the first update to complete so the next poll is in-flight on
    // getUpdates when abort fires.
    await vi.waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });
    await waitForZaloWebhookVerdict(queue, "poll-abort-a", "completed");

    // Abort while the second getUpdates is in-flight; the monitor shuts down
    // before the poll response arrives.
    abort.abort();
    await run;

    // Release the in-flight poll after the monitor has fully shut down.
    latePoll.resolve();

    // With durable-after-stop admission the abort branch must persist the
    // consumed update into the durable ingress queue even after stop.
    await vi.waitFor(async () => {
      const [claims, pending] = await Promise.all([queue.listClaims(), queue.listPending()]);
      const ids = [...claims, ...pending].map((record) => record.id);
      expect(ids).toContain("poll-abort-b");
    });
  });

  it("dead-letters an authentication failure from dispatch without retry", async () => {
    const update = createTextUpdate({
      messageId: "poll-deadletter-1",
      userId: "user-1",
      userName: "User One",
      chatId: "dm-chat-1",
    });
    const { ZaloApiError } = await import("./api.js");
    dispatchMock.mockImplementation(async () => {
      throw new ZaloApiError("Unauthorized", 401, "Unauthorized");
    });
    getUpdatesMock
      .mockResolvedValueOnce({ ok: true, result: update as ZaloUpdate })
      .mockImplementation(() => new Promise(() => {}));

    const { abort, run, runtime } = await startPollingMonitor(
      createLifecycleMonitorSetup({ accountId: "default", dmPolicy: "open", webhookUrl: "" }),
    );

    // Wait for the monitor's own admission before probing the row (see dedupe test).
    await vi.waitFor(() => {
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });
    await waitForZaloWebhookVerdict(queue, "poll-deadletter-1", "failed");
    await settleAsyncWork();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("authentication-failed"));

    abort.abort();
    await run;
  });
});

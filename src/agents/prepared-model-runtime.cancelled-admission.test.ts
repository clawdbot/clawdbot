// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  getPreparedModelRuntimeTestApi,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as runtimeBuild from "./prepared-model-runtime.build.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
  refreshPreparedModelRuntimeSnapshots,
  type PreparedModelRuntimeInput,
  type PreparedModelRuntimeLease,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
const testApi = getPreparedModelRuntimeTestApi();
let state: OpenClawTestState;
let buildBatchSpy: Mock<typeof runtimeBuild.startSerializedSnapshotBuildBatch>;
let pendingBuildReleases: Array<{ resolve: () => void }>;

function prepareColdBuildGate() {
  const started = createDeferred();
  const release = createDeferred();
  pendingBuildReleases.push(release);
  mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return { entries: [] };
  });
  return { started, release };
}

function dynamicInput(label: string): PreparedModelRuntimeInput {
  return {
    agentId: "default",
    agentDir: state.agentDir("default"),
    config: {},
    workspaceDir: `/tmp/${label}`,
  };
}

type AcquireDynamicLease = (
  input: PreparedModelRuntimeInput,
  signal: AbortSignal,
) => Promise<PreparedModelRuntimeLease>;

const coldAdmissionCases: Array<{
  name: string;
  acquire: AcquireDynamicLease;
}> = [
  {
    name: "run",
    acquire: async (input, signal) =>
      await acquireAgentRunPreparedModelRuntime(input, { abortSignal: signal }),
  },
  {
    name: "ephemeral",
    acquire: async (input, signal) =>
      await acquireReadOnlyPreparedModelRuntime(input, signal, "static"),
  },
];

describe("prepared model runtime cancelled admission ownership", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-runtime-cancelled-admission" });
    resetPreparedModelRuntimeHarness(state);
    pendingBuildReleases = [];
    buildBatchSpy = vi.spyOn(runtimeBuild, "startSerializedSnapshotBuildBatch");
  });

  it.each(coldAdmissionCases)(
    "retires a sole cold $name owner before shared discovery finishes",
    async ({ name, acquire }) => {
      const input = dynamicInput(`cancelled-${name}`);
      const build = prepareColdBuildGate();
      const abort = new AbortController();
      const admission = acquire(input, abort.signal);

      await build.started.promise;
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

      abort.abort(new Error("request cancelled"));
      await expect(admission).rejects.toMatchObject({ name: "AbortError" });
      expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);

      build.release.resolve();
    },
  );

  it("retires a coalesced cold owner only after the final admission cancels", async () => {
    const input = dynamicInput("coalesced-cancellations");
    const build = prepareColdBuildGate();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: firstAbort.signal,
    });

    await build.started.promise;
    const second = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: secondAbort.signal,
    });
    const secondObserved = second.then(
      () => "resolved",
      () => "rejected",
    );
    await expect(Promise.race([secondObserved, Promise.resolve("pending")])).resolves.toBe(
      "pending",
    );

    firstAbort.abort(new Error("first request cancelled"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    secondAbort.abort(new Error("second request cancelled"));
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);

    build.release.resolve();
  });

  it("keeps one shared build for a survivor after its peer cancels", async () => {
    const input = dynamicInput("cancelled-peer-survivor");
    const build = prepareColdBuildGate();
    const cancelledAbort = new AbortController();
    const cancelled = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: cancelledAbort.signal,
    });

    await build.started.promise;
    const survivor = acquireAgentRunPreparedModelRuntime(input);

    cancelledAbort.abort(new Error("peer request cancelled"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    build.release.resolve();
    const lease = await survivor;
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledOnce();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    lease.release();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
  });

  it("does not let an abandoned publication satisfy or delete its same-key replacement", async () => {
    const input = dynamicInput("same-key-replacement");
    const firstBuild = prepareColdBuildGate();
    const firstAbort = new AbortController();
    const abandoned = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: firstAbort.signal,
    });

    await firstBuild.started.promise;
    firstAbort.abort(new Error("first request cancelled"));
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);

    const secondBuild = prepareColdBuildGate();
    const replacement = acquireAgentRunPreparedModelRuntime(input);
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    firstBuild.release.resolve();
    await secondBuild.started.promise;
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    secondBuild.release.resolve();
    const lease = await replacement;
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
    lease.release();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
  });

  it("skips workspace preparation for a cancelled queued replacement", async () => {
    const input = dynamicInput("queued-cancelled-replacement");
    const firstBuild = prepareColdBuildGate();
    const firstAbort = new AbortController();
    const first = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: firstAbort.signal,
    });

    await firstBuild.started.promise;
    firstAbort.abort(new Error("first request cancelled"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const queuedAbort = new AbortController();
    const queued = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: queuedAbort.signal,
    });
    queuedAbort.abort(new Error("queued request cancelled"));
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    const survivor = acquireAgentRunPreparedModelRuntime(input);
    firstBuild.release.resolve();

    const lease = await survivor;
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);

    lease.release();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(0);
  });

  it("preserves the configured baseline and clears a later retained lease on refresh", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {};
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    mocks.prepareStaticCatalog.mockClear();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    const input = {
      ...dynamicInput("gateway-retained-owner"),
      config,
    };
    const cancelledBuild = prepareColdBuildGate();
    const abort = new AbortController();
    const cancelled = acquireAgentRunPreparedModelRuntime(input, {
      abortSignal: abort.signal,
    });

    await cancelledBuild.started.promise;
    abort.abort(new Error("gateway request cancelled"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);

    cancelledBuild.release.resolve();
    const retainedLease = await acquireAgentRunPreparedModelRuntime(input);
    expect(mocks.prepareStaticCatalog).toHaveBeenCalledTimes(2);
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(2);

    retainedLease.release();
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(2);

    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    expect(testApi.getPreparedModelRuntimeOwnerCountForTest()).toBe(1);
  });
});

afterEach(async ({ task }) => {
  for (const release of pendingBuildReleases) {
    release.resolve();
  }
  await Promise.all(
    buildBatchSpy.mock.results.flatMap((result) =>
      result.type === "return" ? [result.value.completion] : [],
    ),
  );
  buildBatchSpy.mockRestore();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

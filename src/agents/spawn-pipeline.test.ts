// Spawn pipeline tests cover the admission-time requester lifecycle capture:
// the stamp must be read before async child dispatch so a requester reset
// cannot re-tag the admission with the replacement lifecycle's revision.
import { describe, expect, it } from "vitest";
import { runSpawnPipeline, type SpawnBackendAdapter } from "./spawn-pipeline.js";

type PipelineState = { runId: string };

function minimalRegistration(runId: string, expectedRequesterLifecycleRevision?: string) {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "prove admission stamp",
    cleanup: "keep" as const,
    expectsCompletionMessage: true,
    ...(expectedRequesterLifecycleRevision !== undefined
      ? { expectedRequesterLifecycleRevision }
      : {}),
  };
}

function capturingAdapter(events: string[]): SpawnBackendAdapter<PipelineState> {
  return {
    initialize: async () => {
      events.push("initialize");
      return { runId: "run-1" };
    },
    dispatchTurn: async () => {
      events.push("dispatch");
      return { runId: "run-1" };
    },
    cleanupOnFailure: async () => {},
  };
}

describe("runSpawnPipeline requester lifecycle capture", () => {
  it("captures the requester lifecycle before async child dispatch and registration", async () => {
    const events: string[] = [];
    let registeredRevision: string | undefined;
    await runSpawnPipeline({
      adapter: capturingAdapter(events),
      progressSessionKey: "agent:main:main",
      captureExpectedRequesterLifecycle: () => {
        events.push("capture");
        return "revision-1";
      },
      buildRegistration: (_state, runId, expectedRequesterLifecycleRevision) => {
        events.push("register");
        registeredRevision = expectedRequesterLifecycleRevision;
        return minimalRegistration(runId, expectedRequesterLifecycleRevision);
      },
    });

    expect(events).toEqual(["capture", "initialize", "dispatch", "register"]);
    expect(registeredRevision).toBe("revision-1");
  });

  it("keeps the admission-time revision when the requester is reset before registration", async () => {
    const requesterRevision = { value: "revision-1" };
    const adapter: SpawnBackendAdapter<PipelineState> = {
      initialize: async () => ({ runId: "run-1" }),
      dispatchTurn: async () => {
        // The requester is replaced while child dispatch is in flight.
        requesterRevision.value = "revision-2";
        return { runId: "run-1" };
      },
      cleanupOnFailure: async () => {},
    };
    let registeredRevision: string | undefined;
    await runSpawnPipeline({
      adapter,
      progressSessionKey: "agent:main:main",
      captureExpectedRequesterLifecycle: () => requesterRevision.value,
      buildRegistration: (_state, runId, expectedRequesterLifecycleRevision) => {
        registeredRevision = expectedRequesterLifecycleRevision;
        return minimalRegistration(runId, expectedRequesterLifecycleRevision);
      },
    });

    expect(requesterRevision.value).toBe("revision-2");
    expect(registeredRevision).toBe("revision-1");
  });

  it("passes an undefined admission stamp through without a post-dispatch read", async () => {
    const requesterRevision = { value: undefined as string | undefined };
    let registeredRevision: string | undefined;
    await runSpawnPipeline({
      adapter: {
        initialize: async () => ({ runId: "run-1" }),
        dispatchTurn: async () => {
          // The initial lifecycle has no revision until the first reset; a
          // reset during dispatch must not turn the stamp into a match.
          requesterRevision.value = "revision-2";
          return { runId: "run-1" };
        },
        cleanupOnFailure: async () => {},
      },
      progressSessionKey: "agent:main:main",
      captureExpectedRequesterLifecycle: () => requesterRevision.value,
      buildRegistration: (_state, runId, expectedRequesterLifecycleRevision) => {
        registeredRevision = expectedRequesterLifecycleRevision;
        return minimalRegistration(runId, expectedRequesterLifecycleRevision);
      },
    });

    expect(registeredRevision).toBeUndefined();
  });
});

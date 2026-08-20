// Invocation-bound plugin run-context capability contract tests.
//
// These tests pin the host-authoritative, exactly-once semantics of the
// invocation-bound run-context capability: identity is host-owned (runId +
// pluginId), compare-and-consume is atomic, and closed runs / restarts /
// cross-run / cross-plugin lookups all fail closed.
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import type { PluginJsonValue } from "../host-hook-json.js";
import {
  clearPluginHostRuntimeState,
  compareAndConsumePluginRunContext,
  dispatchPluginAgentEventSubscriptions,
  getPluginRunContext,
  setPluginRunContext,
} from "../host-hook-runtime.js";
import { createPluginRunContextInvocation } from "../run-context-invocation.js";

const RUN_A = "run-a";
const RUN_B = "run-b";
const PLUGIN_X = "plugin-x";
const PLUGIN_Y = "plugin-y";
const NS = "lease";

function seed(runId: string, pluginId: string, namespace: string, value: PluginJsonValue): void {
  setPluginRunContext({ pluginId, patch: { runId, namespace, value } });
}

function closeRun(runId: string): void {
  const event: AgentEventPayload = {
    runId,
    seq: 1,
    stream: "lifecycle",
    ts: Date.now(),
    data: { phase: "end" },
  };
  dispatchPluginAgentEventSubscriptions({ registry: undefined, event });
}

describe("invocation-bound plugin run-context capability", () => {
  afterEach(() => {
    clearPluginHostRuntimeState();
  });

  describe("atomic compare-and-consume", () => {
    it("consumes exactly once and returns the consumed value", () => {
      seed(RUN_A, PLUGIN_X, NS, { token: "t1" });

      const first = compareAndConsumePluginRunContext({
        runId: RUN_A,
        pluginId: PLUGIN_X,
        namespace: NS,
        expected: { token: "t1" },
      });
      expect(first).toEqual({ status: "OK", value: { token: "t1" } });

      const second = compareAndConsumePluginRunContext({
        runId: RUN_A,
        pluginId: PLUGIN_X,
        namespace: NS,
        expected: { token: "t1" },
      });
      expect(second).toEqual({ status: "CONSUMED" });
      expect(
        getPluginRunContext({ pluginId: PLUGIN_X, get: { runId: RUN_A, namespace: NS } }),
      ).toBe(undefined);
    });

    it("does not consume on mismatch", () => {
      seed(RUN_A, PLUGIN_X, NS, { token: "t1" });

      const mismatch = compareAndConsumePluginRunContext({
        runId: RUN_A,
        pluginId: PLUGIN_X,
        namespace: NS,
        expected: { token: "other" },
      });
      expect(mismatch).toEqual({ status: "MISMATCH" });
      expect(
        getPluginRunContext({ pluginId: PLUGIN_X, get: { runId: RUN_A, namespace: NS } }),
      ).toEqual({ token: "t1" });
    });

    it("fails closed for cross-run and cross-plugin lookups", () => {
      seed(RUN_A, PLUGIN_X, NS, { token: "t1" });

      expect(
        compareAndConsumePluginRunContext({
          runId: RUN_B,
          pluginId: PLUGIN_X,
          namespace: NS,
          expected: { token: "t1" },
        }),
      ).toEqual({ status: "NOT_FOUND" });
      expect(
        compareAndConsumePluginRunContext({
          runId: RUN_A,
          pluginId: PLUGIN_Y,
          namespace: NS,
          expected: { token: "t1" },
        }),
      ).toEqual({ status: "NOT_FOUND" });
    });

    it("fails closed for a closed run and an invalid namespace", () => {
      seed(RUN_A, PLUGIN_X, NS, { token: "t1" });
      closeRun(RUN_A);

      expect(
        compareAndConsumePluginRunContext({
          runId: RUN_A,
          pluginId: PLUGIN_X,
          namespace: NS,
          expected: { token: "t1" },
        }),
      ).toEqual({ status: "CLOSED_RUN" });
      expect(
        compareAndConsumePluginRunContext({
          runId: RUN_A,
          pluginId: PLUGIN_X,
          namespace: " ",
          expected: { token: "t1" },
        }),
      ).toEqual({ status: "INVALID" });
    });

    it("clears the tombstone when a new host-authorized set writes the namespace", () => {
      seed(RUN_A, PLUGIN_X, NS, { token: "t1" });
      compareAndConsumePluginRunContext({
        runId: RUN_A,
        pluginId: PLUGIN_X,
        namespace: NS,
        expected: { token: "t1" },
      });
      seed(RUN_A, PLUGIN_X, NS, { token: "t2" });

      expect(
        compareAndConsumePluginRunContext({
          runId: RUN_A,
          pluginId: PLUGIN_X,
          namespace: NS,
          expected: { token: "t2" },
        }),
      ).toEqual({ status: "OK", value: { token: "t2" } });
    });
  });

  describe("invocation window", () => {
    it("allows access only inside the active callback and forbids afterwards", () => {
      const invocation = createPluginRunContextInvocation({ runId: RUN_A, pluginId: PLUGIN_X });
      let leaked: ReturnType<typeof invocation.get> | undefined;
      invocation.withActive(() => {
        invocation.set(NS, { token: "t1" });
        leaked = invocation.get(NS);
      });

      expect(leaked).toEqual({ status: "OK", value: { token: "t1" } });
      expect(invocation.get(NS)).toEqual({ status: "FORBIDDEN" });
      expect(invocation.set(NS, { token: "t2" })).toEqual({ status: "FORBIDDEN" });
    });

    it("fails closed after a closed run", () => {
      const invocation = createPluginRunContextInvocation({ runId: RUN_A, pluginId: PLUGIN_X });
      invocation.withActive(() => {
        invocation.set(NS, { token: "t1" });
      });
      closeRun(RUN_A);

      const result = invocation.withActive(() => invocation.compareAndConsume(NS, { token: "t1" }));
      expect(result).toEqual({ status: "CLOSED_RUN" });
    });

    it("keeps the window open for the lifetime of a resolving async callback", async () => {
      const invocation = createPluginRunContextInvocation({ runId: RUN_A, pluginId: PLUGIN_X });

      const observed = await invocation.withActive(async () => {
        invocation.set(NS, { token: "t1" });
        return invocation.get(NS);
      });

      expect(observed).toEqual({ status: "OK", value: { token: "t1" } });
      expect(invocation.get(NS)).toEqual({ status: "FORBIDDEN" });
    });

    it("closes the window after a rejecting async callback without an extra unhandled rejection", async () => {
      const invocation = createPluginRunContextInvocation({ runId: RUN_A, pluginId: PLUGIN_X });
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const error = new Error("callback failed");
        const run = invocation.withActive(() => Promise.reject(error));
        await expect(run).rejects.toBe(error);
        await new Promise((resolve) => {
          setTimeout(resolve, 25);
        });
        expect(unhandled).toEqual([]);
        expect(invocation.get(NS)).toEqual({ status: "FORBIDDEN" });
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("keeps the window open until every overlapping callback settles", async () => {
      const invocation = createPluginRunContextInvocation({ runId: RUN_A, pluginId: PLUGIN_X });
      let releaseLongCallback!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseLongCallback = resolve;
      });
      const longRunning = invocation.withActive(async () => {
        invocation.set(NS, { token: "t1" });
        await gate;
        return invocation.get(NS);
      });
      const shortRunning = invocation.withActive(async () => invocation.get(NS));

      await expect(shortRunning).resolves.toEqual({ status: "OK", value: { token: "t1" } });
      releaseLongCallback();
      await expect(longRunning).resolves.toEqual({ status: "OK", value: { token: "t1" } });
      expect(invocation.get(NS)).toEqual({ status: "FORBIDDEN" });
    });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSubagentRunByRunId,
  registerSubagentRun,
  resetSubagentRegistryForTests,
  testing,
} from "../src/agents/subagents/registry/subagent-registry.test-helpers.js";
import type { AgentEventPayload } from "../src/infra/agent-events.js";

describe("PR #136554 production registry lifecycle proof", () => {
  const proofRoots = new Set<string>();

  afterEach(async () => {
    testing.setDepsForTest();
    resetSubagentRegistryForTests({ persist: false });
    await Promise.all(
      [...proofRoots].map((proofRoot) => fs.rm(proofRoot, { recursive: true, force: true })),
    );
    proofRoots.clear();
  });

  it(
    "keeps resources live after wait expiry and cleans them after authoritative completion",
    { timeout: 15_000 },
    async () => {
      const proofRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr136554-proof-"));
      proofRoots.add(proofRoot);
      const resourcePath = path.join(proofRoot, "live-child-resource");
      await fs.mkdir(resourcePath);

      let lifecycleHandler: ((event: AgentEventPayload) => void) | undefined;
      const announcements: Array<{ disposition?: string; status?: string }> = [];
      const cleanupBrowserSessionsForLifecycleEnd = vi.fn(async () => {
        await fs.rm(resourcePath, { recursive: true, force: true });
      });

      testing.setDepsForTest({
        callGateway: (async (request: { method?: string }) =>
          request.method === "agent.wait" ? { status: "timeout" } : {}) as never,
        captureSubagentCompletionReply: vi.fn(async () => "terminal reply"),
        cleanupBrowserSessionsForLifecycleEnd: cleanupBrowserSessionsForLifecycleEnd as never,
        getRuntimeConfig: (() => ({
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
          session: { mainKey: "main", scope: "per-sender" },
        })) as never,
        onAgentEvent: ((handler: (event: AgentEventPayload) => void) => {
          lifecycleHandler = handler;
          return () => {};
        }) as never,
        persistSubagentRunsToDisk: vi.fn(),
        persistSubagentRunsToDiskOrThrow: vi.fn(),
        resolveAgentTimeoutMs: (() => 100) as never,
        restoreSubagentRunsFromDisk: vi.fn(() => 0),
        runSubagentAnnounceFlow: (async (params: {
          outcome?: { disposition?: string; status?: string };
        }) => {
          announcements.push({
            status: params.outcome?.status,
            disposition: params.outcome?.disposition,
          });
          return "delivered";
        }) as never,
        maybeWakeRequesterAfterAllChildrenSettled: vi.fn(async () => false),
        ensureContextEnginesInitialized: vi.fn(),
        loadAgentRuntimePluginRegistryHandle: vi.fn(),
        resolveContextEngine: vi.fn(),
      });
      resetSubagentRegistryForTests({ persist: false });

      const runId = "pr136554-live-child";
      const startedAt = Date.now();
      registerSubagentRun({
        runId,
        childSessionKey: "agent:main:subagent:pr136554-live-child",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "hold a resource past the parent wait budget",
        cleanup: "keep",
        runTimeoutSeconds: 1,
      });

      await expect
        .poll(() => getSubagentRunByRunId(runId)?.waitExpiryObservedAt, {
          timeout: 5_000,
          interval: 25,
        })
        .toEqual(expect.any(Number));

      const provisional = getSubagentRunByRunId(runId);
      expect(provisional?.execution.status).toBe("running");
      expect(provisional?.execution.endedAt).toBeUndefined();
      await expect(fs.stat(resourcePath)).resolves.toBeDefined();
      expect(cleanupBrowserSessionsForLifecycleEnd).not.toHaveBeenCalled();
      expect(announcements).toContainEqual({
        status: "timeout",
        disposition: "still-running",
      });

      lifecycleHandler?.({
        runId,
        seq: 1,
        stream: "lifecycle",
        ts: startedAt + 1_500,
        sessionKey: "agent:main:subagent:pr136554-live-child",
        data: {
          phase: "end",
          startedAt,
          endedAt: startedAt + 1_500,
        },
      });

      await expect
        .poll(() => getSubagentRunByRunId(runId)?.execution.status, {
          timeout: 5_000,
          interval: 25,
        })
        .toBe("terminal");
      await expect
        .poll(
          async () => {
            try {
              await fs.stat(resourcePath);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === "ENOENT";
            }
          },
          { timeout: 5_000, interval: 25 },
        )
        .toBe(true);
      expect(cleanupBrowserSessionsForLifecycleEnd).toHaveBeenCalledTimes(1);

      const terminal = getSubagentRunByRunId(runId);
      console.log(
        "PR136554_RUNTIME_TRACE " +
          JSON.stringify({
            provisional: {
              disposition: "still-running",
              executionStatus: provisional?.execution.status,
              resourcePreserved: true,
            },
            terminal: {
              executionStatus: terminal?.execution.status,
              outcome: terminal?.execution.outcome?.status,
              resourceCleaned: true,
            },
          }),
      );
      await fs.rm(proofRoot, { recursive: true, force: true });
      proofRoots.delete(proofRoot);
    },
  );
});

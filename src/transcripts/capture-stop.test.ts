import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTranscriptsTool } from "../agents/tools/transcripts-tool.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import type { TranscriptSourceProvider, TranscriptStartRequest } from "./provider-types.js";
import { TranscriptsStore } from "./store.js";

const tempDirs = createTempDirTracker();
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("transcript provider cleanup custody", () => {
  it.each([
    { owner: "tool", failure: "returned", registryChange: "none" },
    { owner: "tool", failure: "thrown", registryChange: "none" },
    { owner: "service", failure: "returned", registryChange: "none" },
    { owner: "service", failure: "thrown", registryChange: "none" },
    { owner: "manual-service", failure: "returned", registryChange: "none" },
    { owner: "tool", failure: "returned", registryChange: "removed" },
    { owner: "tool", failure: "thrown", registryChange: "replaced" },
  ] as const)(
    "retains $owner cleanup after a $failure failure with provider $registryChange",
    async ({ owner, failure, registryChange }) => {
      const stateDir = tempDirs.make("transcript-stop-custody-");
      const requests: TranscriptStartRequest[] = [];
      let subscribed = false;
      let failing = true;
      const stop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(async ({ sessionId }) => {
        if (failing) {
          if (failure === "thrown") {
            throw new Error("cleanup unavailable");
          }
          return { ok: false, error: "cleanup unavailable" };
        }
        subscribed = false;
        return { ok: true, sessionId };
      });
      const provider: TranscriptSourceProvider = {
        id: "cleanup-capture",
        name: "Cleanup capture",
        sourceKinds: ["live-caption"],
        start: async (request) => {
          requests.push(request);
          subscribed = true;
          return { ok: true, session: request.session };
        },
        stop,
      };
      const registry = createEmptyPluginRegistry();
      const registration = { pluginId: provider.id, provider, source: import.meta.url };
      registry.transcriptSourceProviders.push(registration);
      const ctx = {
        stateDir,
        agentId: "main",
        config: {
          plugins: { enabled: true },
          transcripts: { autoStart: [{ providerId: provider.id, sessionId: "notes" }] },
        },
        logger: { warn: vi.fn() },
        caller: { kind: "operator" as const, source: "local" as const },
      };
      const tool = createTranscriptsTool(ctx);
      const service = createTranscriptsAutoStartService(ctx);
      const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const replacementStop = vi.fn<NonNullable<TranscriptSourceProvider["stop"]>>(
        async ({ sessionId }) => ({ ok: true, sessionId }),
      );
      await withPluginRuntimeRegistryScope(registry, async () => {
        try {
          if (owner !== "tool") {
            service.start();
            await vi.waitFor(async () =>
              expect(await tool.execute("status", { action: "status" })).toMatchObject({
                details: { active: [{ sessionId: "notes" }] },
              }),
            );
          } else {
            await tool.execute("start", {
              action: "start",
              providerId: provider.id,
              sessionId: "notes",
            });
          }
          const request = requests[0]!;
          await request.onUtterance({ text: "Saved before stop" });
          if (owner === "service") {
            await service.stop();
            expect
              .soft(ctx.logger.warn)
              .toHaveBeenCalledWith(expect.stringMatching(/stop failed.*cleanup unavailable/));
          } else {
            await expect
              .soft(tool.execute("stop", { action: "stop", sessionId: "notes" }))
              .rejects.toThrow("cleanup unavailable");
          }
          expect.soft(subscribed).toBe(true);
          await expect.soft(tool.execute("status", { action: "status" })).resolves.toMatchObject({
            details: {
              active: [{ sessionId: "notes", cleanupPending: true }],
              pendingFinalization: [],
            },
          });
          expect.soft((await store.readSession("notes"))?.stoppedAt).toBeUndefined();
          await request.onUtterance({ text: "Too late after failed stop" });
          expect
            .soft((await store.readUtterancesForSession(request.session)).map((line) => line.text))
            .toEqual(["Saved before stop"]);
          if (registryChange === "removed") {
            ctx.config.plugins.enabled = false;
            registry.transcriptSourceProviders.splice(0);
          } else if (registryChange === "replaced") {
            registry.transcriptSourceProviders[0] = {
              ...registration,
              provider: { ...provider, stop: replacementStop },
            };
          }
          failing = false;
          if (owner !== "tool") {
            await service.stop();
          } else {
            await tool.execute("retry-stop", { action: "stop", sessionId: "notes" });
          }
          expect.soft(stop).toHaveBeenCalledTimes(2);
          expect.soft(replacementStop).not.toHaveBeenCalled();
          expect.soft(subscribed).toBe(false);
          await expect(tool.execute("status", { action: "status" })).resolves.toMatchObject({
            details: { active: [], pendingFinalization: [] },
          });
          expect((await store.readSummary(request.session)).summary?.transcript).toEqual([
            "Saved before stop",
          ]);
        } finally {
          failing = false;
          ctx.config.plugins.enabled = true;
          registry.transcriptSourceProviders.splice(
            0,
            registry.transcriptSourceProviders.length,
            registration,
          );
          await service.stop();
          if (requests.length) {
            await tool.execute("cleanup", { action: "stop", sessionId: "notes" });
          }
        }
      });
    },
  );
});

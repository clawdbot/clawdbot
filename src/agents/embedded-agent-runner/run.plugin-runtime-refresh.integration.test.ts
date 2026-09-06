import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";

let state: OpenClawTestState;

async function loadRuntimeRefreshHarness() {
  const loaded = await loadRunOverflowCompactionHarness();
  const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
  state = await createOpenClawTestState({ label: "plugin-runtime-refresh" });
  return loaded;
}

afterEach(async () => {
  await state?.cleanup();
});

describe("plugin runtime refresh admission", () => {
  it.each([
    { nativeHistory: false, nativeAuth: undefined },
    { nativeHistory: true, nativeAuth: undefined },
    { nativeHistory: true, nativeAuth: "native" },
    { nativeHistory: true, nativeAuth: "host" },
  ] as const)(
    "re-admits repeated reloads without losing committed work or changing run authority (native history=$nativeHistory, native auth=$nativeAuth)",
    async ({ nativeHistory, nativeAuth }) => {
      const { runEmbeddedAgent, registerPreparedAgentHarness } = await loadRuntimeRefreshHarness();
      const { getAgentRunContext } = await import("../../infra/agent-run-registry.js");
      const runParams = createOverflowRunParams(state);
      const nativeModelRef = { provider: "openai", model: "native-model" };
      if (nativeAuth) {
        const { resolveSessionStorePathCore } = await import("../../config/sessions.js");
        const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
        const { getRegisteredAgentHarness } = await import("../harness/registry.js");
        await replaceSessionEntry(
          {
            agentId: runParams.agentId,
            sessionKey: runParams.sessionKey,
            storePath: resolveSessionStorePathCore(undefined, { agentId: runParams.agentId }),
          },
          {
            sessionId: runParams.sessionId,
            updatedAt: 1,
            agentHarnessId: "codex",
            modelSelectionLocked: true,
          },
        );
        registerPreparedAgentHarness({
          ...getRegisteredAgentHarness("codex")!.harness,
          resolveSessionRuntimeOwnership: ({ assertCurrent }) => {
            assertCurrent();
            return nativeAuth === "host"
              ? { model: "native", auth: "host", modelRef: nativeModelRef }
              : { model: "native", auth: "native" };
          },
        });
      }
      const originalPrompt = "edit and reload twice";
      const originalMessage = { role: "user" as const, content: originalPrompt, timestamp: 1 };
      const nativeSnapshots: AgentMessage[][] = [1, 2].map((index) => [
        {
          role: "toolResult",
          toolCallId: `committed-${index}`,
          toolName: "plugins",
          content: [{ type: "text", text: `generation ${index + 1} committed` }],
          isError: false,
          timestamp: index + 1,
        },
      ]);
      nativeSnapshots[0]!.unshift(originalMessage);
      const onUserMessagePersisted = vi.fn();
      const base = await mockedAcquireAgentRunPreparedModelRuntime({
        agentId: "main",
        agentDir: state.agentDir(),
        config: {},
        workspaceDir: state.workspaceDir,
      });
      // Generations need independent registry identities; mutating the shared fixture masks stale ownership.
      // oxlint-disable-next-line no-map-spread
      const snapshots = ["first", "next", "final"].map((policyHash) => ({
        ...base.snapshot,
        metadataSnapshot: {
          ...base.snapshot.metadataSnapshot,
          policyHash,
          workspaceDir: state.workspaceDir,
        },
        pluginRegistry: {
          ...base.snapshot.pluginRegistry!,
          tools: [...(base.snapshot.pluginRegistry?.tools ?? [])],
        },
      }));
      const first = snapshots[0]!;
      const generation: PreparedModelRuntimePluginGeneration = {
        configuredCatalogEntries: [],
        inlineProviderModels: [],
        pluginMetadataSnapshot: first.metadataSnapshot,
        pluginRegistry: first.pluginRegistry,
      };
      const releases = snapshots.map(() => vi.fn());
      const caller = { isWebchatConnect: () => false, invokeWithSessionNodeAuthority: vi.fn() };
      mockedAcquireAgentRunPreparedModelRuntime.mockClear();
      let admittedOwner: unknown;
      const staleOwners: ReturnType<typeof captureAgentPluginRuntimeRefresh>[] = [];
      for (const [index, snapshot] of snapshots.entries()) {
        mockedAcquireAgentRunPreparedModelRuntime.mockImplementationOnce(async () => {
          if (index > 0) {
            expect(releases[index - 1]).toHaveBeenCalledOnce();
            expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
            expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
            expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBeUndefined();
            expect(getPluginRuntimeGatewayRequestScope()?.invokeWithSessionNodeAuthority).toBe(
              caller.invokeWithSessionNodeAuthority,
            );
          }
          return { ...base, snapshot, release: releases[index]! };
        });
        mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
          if (index === 0) {
            admittedOwner = getAgentRunContext(params.runId)?.delegatedAuthority;
            expect(admittedOwner).toBeDefined();
            expect(params.prompt).toBe(originalPrompt);
            params.onUserMessagePersisted?.(originalMessage);
          } else {
            expect(getAgentRunContext(params.runId)?.delegatedAuthority).toBe(admittedOwner);
            expect(params.prompt).toContain("Continue the current task from the transcript");
            expect(params.prompt).toContain("do not repeat completed actions");
            expect(params.prompt).not.toContain(originalPrompt);
            expect(params.skipPreparedUserTurnMessage).toBe(true);
            expect(params.suppressNextUserMessagePersistence).toBe(true);
            expect(params.pluginRuntimeRefreshMessages).toEqual(
              nativeHistory ? nativeSnapshots.slice(0, index).flat() : [],
            );
            for (const stale of staleOwners) {
              expect(() => stale.assertCurrent()).toThrow("Plugin runtime changed");
            }
          }
          expect(params.hostCapabilities).toBeDefined();
          params.hostCapabilities?.assertActive();
          expect(params.sessionId).toBe("test-session");
          expect(params.expectedSessionRuntimeOwnership).toEqual(
            nativeAuth
              ? {
                  model: "native",
                  auth: nativeAuth,
                  ...(nativeAuth === "host" ? { modelRef: nativeModelRef } : {}),
                }
              : undefined,
          );
          if (nativeAuth === "host") {
            expect(params.provider).toBe(nativeModelRef.provider);
            expect(params.modelId).toBe(nativeModelRef.model);
          }
          expect(getPluginRuntimeGenerationRegistry()).toBe(snapshot.pluginRegistry);
          if (index < nativeSnapshots.length) {
            const owner = captureAgentPluginRuntimeRefresh();
            staleOwners.push(owner);
            expect(
              owner.request({
                operationId: `reload-${index}`,
                generation: index + 2,
                pluginIds: ["fixture"],
              }),
            ).toBe(true);
            return makeAttemptResult({
              assistantTexts: [],
              sessionIdUsed: params.sessionId,
              toolMetas: [{ toolName: "plugins" }],
              messagesSnapshot: nativeHistory
                ? nativeSnapshots[index]!
                : nativeSnapshots.slice(0, index + 1).flat(),
              ...(nativeHistory ? { pluginRuntimeRefreshMessages: nativeSnapshots[index]! } : {}),
            });
          }
          return makeAttemptResult({
            assistantTexts: ["new behavior verified"],
            sessionIdUsed: params.sessionId,
          });
        });
      }
      mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "new behavior verified" }]);
      useOpenAIPlatformAuthFixture();
      try {
        const result = await withPluginRuntimeGatewayRequestScope(caller, () =>
          withPreparedModelRuntimePluginGenerationScope(
            generation,
            () =>
              withPluginRuntimeGenerationScope(first, () =>
                runEmbeddedAgent({
                  ...runParams,
                  prompt: originalPrompt,
                  onUserMessagePersisted,
                  provider: "openai",
                  model: "gpt-5.4",
                  sessionKey: nativeAuth ? runParams.sessionKey : undefined,
                  ...(nativeAuth ? { agentHarnessId: "codex", modelSelectionLocked: true } : {}),
                }),
              ),
            () => first as NonNullable<ReturnType<typeof getPreparedModelRuntimeBorrowedSnapshot>>,
          ),
        );
        expect(result.payloads).toEqual([{ text: "new behavior verified" }]);
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
        expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledTimes(3);
        expect(onUserMessagePersisted).toHaveBeenCalledExactlyOnceWith(originalMessage);
        for (const release of releases) {
          expect(release).toHaveBeenCalledOnce();
        }
      } finally {
        // A failed generation must not leave queued replies in the next table row.
        mockedAcquireAgentRunPreparedModelRuntime.mockReset();
        mockedRunEmbeddedAttempt.mockReset();
      }
    },
  );
});

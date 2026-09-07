import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import {
  createCodexTestBindingStore,
  readCodexAppServerBinding,
  resolveCodexSessionBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

describe("Codex finalization generation ownership", () => {
  it.each([false, true])(
    "preserves successor continuity after agent_end outlives the recovered generation (coverage storage rejects: %s)",
    async (rejectCoverage) => {
      const sessionFile = path.join(tempDir, "generation-coverage.jsonl");
      const workspaceDir = path.join(tempDir, "generation-coverage-workspace");
      const params = createParams(sessionFile, workspaceDir);
      const current = {
        kind: "session" as const,
        agentId: "main",
        sessionKey: params.sessionKey!,
        sessionId: params.sessionId,
      };
      const previous = { ...current, sessionId: "before-compaction" };
      const successor = { ...current, sessionId: "after-compaction" };
      const scope = {
        agentId: current.agentId,
        sessionKey: current.sessionKey,
        storePath: path.join(tempDir, "admitted", "sessions.json"),
      };
      params.sessionTarget = { ...scope, sessionId: current.sessionId };
      await upsertSessionEntry({
        ...scope,
        entry: { sessionId: previous.sessionId, updatedAt: 1 },
      });
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
      const baseStore = createCodexTestBindingStore();
      await baseStore.mutate(previous, {
        kind: "set",
        binding: {
          threadId: "thread-existing",
          cwd: workspaceDir,
          dynamicToolsFingerprint: "[]",
          webSearchThreadConfigFingerprint: JSON.stringify({
            "features.standalone_web_search": false,
            web_search: "disabled",
          }),
          historyCoveredThrough: new Date(1).toISOString(),
        },
      });
      const bindingStore = {
        ...baseStore,
        mutate: async (...args: Parameters<typeof baseStore.mutate>) => {
          if (rejectCoverage && args[1].kind === "patch" && args[1].patch.historyCoveredThrough) {
            throw new Error("simulated binding coverage write failure");
          }
          return await baseStore.mutate(...args);
        },
      };
      const enteredAgentEnd = createDeferred<void>();
      const releaseAgentEnd = createDeferred<void>();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "agent_end",
            handler: async (event) => {
              if (!isRecord(event) || !event.success) {
                return;
              }
              enteredAgentEnd.resolve();
              await releaseAgentEnd.promise;
            },
          },
        ]),
      );
      const harness = createResumeHarness();
      const run = runCodexAppServerAttempt(params, { bindingStore });
      const settledRun = run.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          harness.waitForMethod("turn/start"),
          run.then(() => {
            throw new Error("Codex turn settled before turn/start");
          }),
        ]);
        const admittedBinding = baseStore.read(current);
        expect(admittedBinding).toMatchObject({ threadId: "thread-existing" });
        await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
        await Promise.race([
          enteredAgentEnd.promise,
          settledRun.then(() => {
            throw new Error("Codex turn settled before agent_end held finalization");
          }),
        ]);
        await patchSessionEntry({ ...scope, update: () => ({ sessionId: successor.sessionId }) });
        const marker = "successor message never sent to the previous native turn";
        const timestamp = Date.now();
        expect(timestamp).toBeGreaterThan(Date.parse(admittedBinding!.historyCoveredThrough!));
        expect(
          await appendSessionTranscriptMessageByIdentity({
            ...scope,
            sessionId: successor.sessionId,
            message: { role: "user", content: marker, timestamp },
          }),
        ).toBeDefined();
        releaseAgentEnd.resolve();
        const outcome = await settledRun;

        expect(baseStore.read(current)).toEqual(admittedBinding);
        expect(outcome).toMatchObject({ error: { name: "AgentHarnessSessionSupersededError" } });
        const adopted = await resolveCodexSessionBinding({
          bindingStore: baseStore,
          identity: successor,
          storePath: scope.storePath,
        });
        expect(adopted.binding).toEqual(admittedBinding);
        harness.close();

        const nextHarness = createResumeHarness();
        const nextParams = createParams(sessionFile, workspaceDir, {
          sessionId: successor.sessionId,
          runId: "run-successor",
          prompt: "continue after compaction",
        });
        nextParams.sessionTarget = { ...scope, sessionId: successor.sessionId };
        const nextRun = runCodexAppServerAttempt(nextParams, { bindingStore: baseStore });
        await nextHarness.waitForMethod("turn/start");
        await nextHarness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
        await nextRun;
        expect(
          nextHarness.requests.find(({ method }) => method === "turn/start")?.params,
        ).toMatchObject({
          threadId: "thread-existing",
          input: [expect.objectContaining({ text: expect.stringContaining(marker) })],
        });
      } finally {
        releaseAgentEnd.resolve();
        await settledRun;
      }
    },
  );

  it("clears a stale binding when completed-turn coverage persistence fails", async () => {
    const sessionFile = path.join(tempDir, "binding-coverage-failure.jsonl");
    const workspaceDir = path.join(tempDir, "binding-coverage-workspace");
    const harness = createStartedThreadHarness();
    const bindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
        const mutation = args[1];
        if (mutation.kind === "patch" && mutation.patch.historyCoveredThrough) {
          throw new Error("simulated binding coverage write failure");
        }
        return await testCodexAppServerBindingStore.mutate(...args);
      }),
    };
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), { bindingStore });
    await harness.waitForMethod("turn/start");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    expect(readAttemptTerminal(await run)).toMatchObject({ promptError: null, aborted: false });
    expect(bindingStore.mutate).toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });
});

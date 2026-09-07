/** Pending native preparation must transfer only live invocation authority to the child owner. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { forkSessionEntryFromParent } from "../../../auto-reply/reply/session-fork.js";
import {
  listSessionChildEntriesReadOnly,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { handleChatAbortRequest } from "../../../gateway/server-methods/chat-abort-handler.js";
import { invokeChatAbortHandler } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionDeleteHandlers } from "../../../gateway/server-methods/sessions-delete.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
} from "../../admitted-run-context.js";
import { finalizeAgentToolAvailability } from "../../agent-tool-availability.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import { finalizeAgentTools } from "../../agent-tools.finalize.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { createAgentHarnessHostCapabilities } from "../../harness/host-capability.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { enqueueSwarmRun } from "../swarm/swarm-scheduler.js";
import {
  installSpawnAuthorityFixture,
  installSpawnThreadBindingFixture,
  installSpawnAttachmentFixture,
} from "./subagent-spawn.authority.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const fixture = installSpawnAuthorityFixture();
const { parentSessionKey, parentRunId, groupId, createBoundParent } = fixture;

describe("pending spawn preparation authority", () => {
  it.each(["closed", "live"])(
    "checks parent authority after queued fork preparation: %s",
    async (closure) => {
      const bindingFixture = installSpawnThreadBindingFixture();
      const { cfg, storePath, context, admission, parent, admitted } = await createBoundParent();
      await replaceTranscriptEvents(
        { agentId: "main", sessionId: "parent-session", sessionKey: parentSessionKey, storePath },
        [
          {
            type: "session",
            version: 3,
            id: "parent-session",
            timestamp: "2026-09-05T00:00:00Z",
            cwd: fixture.stateDir,
          },
          {
            type: "message",
            id: "parent-message",
            parentId: null,
            timestamp: "2026-09-05T00:00:01Z",
            message: { role: "user", content: "synthetic parent context" },
          },
          {
            type: "message",
            id: "parent-answer",
            parentId: "parent-message",
            timestamp: "2026-09-05T00:00:02Z",
            message: {
              role: "assistant",
              content: "synthetic completed reply",
              stopReason: "stop",
            },
          },
        ],
      );
      const writerEntered = createDeferred();
      const releaseWriter = createDeferred();
      const forkQueued = createDeferred<{ childSessionKey: string; initialSessionId: string }>();
      const forkSettled = createDeferred<
        Awaited<ReturnType<typeof forkSessionEntryFromParent>> | Error
      >();
      const inspected = createDeferred();
      let blocker: Promise<void> | undefined;
      const dispatch = vi.fn();
      const deleted: string[] = [];
      spawnTesting.setDepsForTest({
        forkSessionEntryFromParent: async (params) => {
          // Hold a genuine preceding database writer, then enqueue the real fork owner.
          blocker = runExclusiveSqliteSessionWrite(resolveSqliteStoreScope(storePath), async () => {
            writerEntered.resolve();
            await releaseWriter.promise;
          });
          await writerEntered.promise;
          const initial = loadSessionEntry({ storePath, sessionKey: params.sessionKey })!;
          const pending = forkSessionEntryFromParent(params);
          forkQueued.resolve({
            childSessionKey: params.sessionKey,
            initialSessionId: initial.sessionId,
          });
          try {
            const result = await pending;
            forkSettled.resolve(result);
            await inspected.promise;
            return result;
          } catch (error) {
            forkSettled.resolve(error instanceof Error ? error : new Error(String(error)));
            await inspected.promise;
            throw error;
          }
        },
        resolveContextEngine: async () => new LegacyContextEngine(),
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
        ) => {
          if (method === "agent") {
            dispatch(params);
            return { runId: params.idempotencyKey, status: "accepted" } as T;
          }
          if (method !== "sessions.delete") {
            throw new Error(`Unexpected spawn RPC ${method}`);
          }
          let payload: unknown;
          await sessionDeleteHandlers["sessions.delete"]!({
            req: {} as never,
            params,
            context: context as unknown as GatewayRequestContext,
            client: createSyntheticPluginRuntimeClient(),
            isWebchatConnect: () => false,
            respond: (ok, result, error) => {
              if (!ok) {
                throw new Error(error?.message ?? "delete failed");
              }
              payload = result;
            },
          });
          deleted.push(params.key as string);
          return payload as T;
        },
      });
      const [tool] = finalizeAgentTools({
        tools: [
          createSessionsSpawnTool({
            config: cfg,
            agentSessionKey: parentSessionKey,
            requesterRunId: parentRunId,
            requesterTurnRunId: parentRunId,
            agentChannel: "matrix",
            agentAccountId: "default",
            agentTo: "room:parent",
          }),
        ],
        hookContext: {
          config: cfg,
          agentId: "main",
          sessionKey: parentSessionKey,
          runId: parentRunId,
        },
        abortSignal: parent.controller.signal,
      });
      const pending = withPluginRuntimeGatewayRequestScope(
        { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
        () =>
          withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: admitted,
              agentId: "main",
              sessionKey: parentSessionKey,
            }),
            () =>
              tool!.execute!("spawn-fork-queued", {
                task: "bounded fork",
                context: "fork",
                thread: true,
                mode: "run",
                attachments: [{ name: "synthetic.txt", content: "synthetic attachment" }],
                expectsCompletionMessage: false,
              }),
          ),
      ).then(
        (value) => value,
        (error: unknown) => error,
      );
      try {
        const { childSessionKey, initialSessionId } = await Promise.race([
          forkQueued.promise,
          pending.then((result) => {
            throw new Error(`Spawn settled before fork queue: ${JSON.stringify(result)}`);
          }),
        ]);
        expect(subagentRuns.size).toBe(0);
        expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toMatchObject({
          model: "gpt-5.4",
          modelProvider: "openai",
          modelOverride: "gpt-5.4",
          providerOverride: "openai",
        });
        if (closure === "closed") {
          admission.close();
          expect(parent.controller.signal.aborted).toBe(false);
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
        }
        releaseWriter.resolve();
        const result = await forkSettled.promise;
        const entry = loadSessionEntry({ storePath, sessionKey: childSessionKey })!;
        const transcript = await loadTranscriptEvents({
          agentId: "main",
          sessionId: entry.sessionId,
          sessionKey: childSessionKey,
          storePath,
        });
        if (closure === "closed") {
          expect
            .soft(entry.sessionId, "closed parent must not replace the provisional child identity")
            .toBe(initialSessionId);
          expect
            .soft(transcript, "closed parent must not copy its transcript after writer queue wait")
            .toEqual([]);
          expect.soft(result).toBeInstanceOf(Error);
        } else {
          expect(result).toMatchObject({ status: "forked" });
          expect(entry.sessionId).not.toBe(initialSessionId);
          expect(entry).toMatchObject({ model: "gpt-5.4", modelProvider: "openai" });
          expect(transcript).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "message",
                message: { role: "user", content: "synthetic parent context" },
              }),
            ]),
          );
        }
        inspected.resolve();
        const outcome = await pending;
        if (closure === "closed") {
          expect(outcome).toMatchObject({ details: { status: "error" } });
          expect(dispatch).not.toHaveBeenCalled();
          expect(subagentRuns.size).toBe(0);
          expect(deleted).toEqual([childSessionKey]);
          expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeUndefined();
        } else {
          expect(outcome).toMatchObject({ details: { status: "accepted" } });
          expect(dispatch).toHaveBeenCalledOnce();
          expect(bindingFixture.bind).toHaveBeenCalledOnce();
          const details = (outcome as { details: { attachments: { relDir: string } } }).details;
          expect(
            await fs.readFile(
              path.join(fixture.stateDir, details.attachments.relDir, "synthetic.txt"),
              "utf8",
            ),
          ).toBe("synthetic attachment");
        }
      } finally {
        releaseWriter.resolve();
        inspected.resolve();
        await blocker;
        await pending;
        admission.close();
        parent.cleanup();
        bindingFixture.unregister();
      }
    },
  );

  it.each([
    "native engine resolution",
    "native thread binding",
    "native attachment staging",
    "native attachment directory",
    "native attachment files",
    "native abort",
    "native acceptance",
    "native call signal",
    "native construction signal",
    "native claim loss",
    "native replacement",
    "native lifecycle rotation",
    "native admission close",
    "projected close",
    "projected claim loss",
  ])("rolls back an untransferred native spawn: %s", async (closure) => {
    const entered = createDeferred<string>();
    const release = createDeferred();
    const hasThread =
      closure === "native thread binding" || closure === "native attachment staging";
    const hasAttachments = closure.startsWith("native attachment");
    const bindingFixture = hasThread
      ? installSpawnThreadBindingFixture(async (binding) => {
          if (closure === "native attachment staging") {
            entered.resolve(binding.targetSessionKey);
            await release.promise;
          }
        })
      : undefined;
    const { cfg, storePath, context, admission, parent, admitted, authority } =
      await createBoundParent(closure.startsWith("projected") ? "plugin-harness" : "embedded");
    if (closure === "native thread binding") {
      await replaceTranscriptEvents(
        { agentId: "main", sessionId: "parent-session", sessionKey: parentSessionKey, storePath },
        [
          {
            type: "session",
            version: 3,
            id: "parent-session",
            timestamp: "2026-09-05T00:00:00Z",
            cwd: fixture.stateDir,
          },
        ],
      );
    }
    const readChildKey = () =>
      listSessionChildEntriesReadOnly({ storePath, sessionKey: parentSessionKey })[0]!.sessionKey;
    const attachmentFixture = hasAttachments
      ? installSpawnAttachmentFixture({
          stateDir: fixture.stateDir,
          admitted,
          pauseAt:
            closure === "native attachment directory"
              ? "directory"
              : closure === "native attachment files"
                ? "files"
                : undefined,
          entered: () => entered.resolve(readChildKey()),
          release: release.promise,
        })
      : undefined;
    const acceptedGate = createDeferred();
    const acceptedEntered = createDeferred();
    let childController: ReturnType<typeof registerChatAbortController> | undefined;
    const rollback = vi.fn(async () => {});
    const prepare = vi.fn(async ({ childSessionKey }: { childSessionKey: string }) => {
      entered.resolve(childSessionKey);
      await release.promise;
      return { rollback };
    });
    const agentDispatch = vi.fn();
    const deleted: string[] = [];
    spawnTesting.setDepsForTest({
      forkSessionEntryFromParent: async (params) => {
        const result = await forkSessionEntryFromParent(params);
        if (closure === "native thread binding") {
          entered.resolve(params.sessionKey);
          await release.promise;
        }
        return result;
      },
      resolveContextEngine: async () => {
        if (closure === "native engine resolution") {
          entered.resolve(readChildKey());
          await release.promise;
        }
        return Object.assign(new LegacyContextEngine(), { prepareSubagentSpawn: prepare });
      },
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        if (method === "agent") {
          agentDispatch(params);
          if (closure === "native acceptance") {
            const childSessionKey = params.sessionKey as string;
            const child = loadSessionEntry({ storePath, sessionKey: childSessionKey })!;
            childController = registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId: params.idempotencyKey as string,
              sessionKey: childSessionKey,
              sessionId: child.sessionId,
              agentId: "main",
              timeoutMs: 60_000,
            });
            acceptedEntered.resolve();
            await acceptedGate.promise;
          }
          return { runId: params.idempotencyKey, status: "accepted" } as T;
        }
        if (method === "chat.abort") {
          const respond = await invokeChatAbortHandler({
            handler: handleChatAbortRequest,
            context,
            request: params as { sessionKey: string; runId: string },
            client: createSyntheticPluginRuntimeClient(),
          });
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ aborted: true, runIds: [params.runId] }),
          );
          return respond.mock.calls[0]![1] as T;
        }
        if (method !== "sessions.delete") {
          throw new Error(`Unexpected spawn RPC ${method}`);
        }
        let payload: unknown;
        await sessionDeleteHandlers["sessions.delete"]!({
          req: {} as never,
          params,
          context: context as unknown as GatewayRequestContext,
          client: createSyntheticPluginRuntimeClient(),
          isWebchatConnect: () => false,
          respond: (ok, result, error) => {
            if (!ok) {
              throw new Error(error?.message ?? "delete failed");
            }
            payload = result;
          },
        });
        deleted.push(params.key as string);
        return payload as T;
      },
    });
    const invocationAbort = new AbortController();
    let replacementAuthority: ReturnType<typeof claimAgentRunDelegatedAuthority> | undefined;
    const host = closure.startsWith("projected")
      ? createAgentHarnessHostCapabilities({
          attempt: {
            admittedRunContext: admitted,
            runId: parentRunId,
            config: cfg,
            agentId: "main",
            sessionKey: parentSessionKey,
            abortSignal: parent.controller.signal,
          },
          pluginId: "test-harness",
        })
      : undefined;
    const source = createSessionsSpawnTool({
      config: cfg,
      agentSessionKey: parentSessionKey,
      requesterRunId: parentRunId,
      requesterTurnRunId: parentRunId,
      agentChannel: hasThread ? "matrix" : undefined,
      agentAccountId: hasThread ? "default" : undefined,
      agentTo: hasThread ? "room:parent" : undefined,
      signal: closure === "native construction signal" ? invocationAbort.signal : undefined,
    });
    let forwarded: Promise<unknown> | undefined;
    const observed: AnyAgentTool = copyAgentToolMetadata(source, {
      ...source,
      execute: (...args) => {
        const pending = source.execute!(...args);
        // Observe, but still forward the real source promise through the native wrappers.
        forwarded = pending.then(
          (result) => result,
          (error: unknown) => error,
        );
        return pending;
      },
    });
    const wait = createAgentsWaitTool({
      config: cfg,
      agentSessionKey: parentSessionKey,
      agentId: "main",
    });
    const tools = [observed, wait];
    const [tool] = host
      ? finalizeAgentToolAvailability(host.capabilities.bindToolSurface(tools))
      : finalizeAgentTools({
          tools,
          hookContext: {
            config: cfg,
            agentId: "main",
            sessionKey: parentSessionKey,
            runId: parentRunId,
          },
          abortSignal: parent.controller.signal,
        });
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: parentSessionKey,
    });
    const wrapped = withPluginRuntimeGatewayRequestScope(
      { context: context as unknown as GatewayRequestContext, isWebchatConnect: () => false },
      () =>
        withGatewayToolCallerIdentity(caller, () =>
          tool!.execute!(
            "spawn-pending",
            {
              task: "bounded child",
              collect: closure !== "native acceptance" && !hasThread,
              thread: hasThread,
              context: closure === "native thread binding" ? "fork" : "isolated",
              attachments: hasAttachments
                ? [{ name: "synthetic.txt", content: "synthetic attachment" }]
                : undefined,
              groupId: closure === "native acceptance" || hasThread ? undefined : groupId,
            },
            closure === "native call signal" ? invocationAbort.signal : undefined,
          ),
        ),
    );
    const wrappedOutcome = wrapped.then(
      (result) => result,
      (error: unknown) => error,
    );
    try {
      // A rejected spawn never enters preparation; report it instead of waiting for the test timeout.
      const childSessionKey = await Promise.race([
        entered.promise,
        wrapped.then(() => {
          throw new Error("Spawn settled before entering context preparation");
        }),
      ]);
      expect(subagentRuns.size, "no ownership transfer before preparation resolves").toBe(0);
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeDefined();
      if (closure === "native acceptance") {
        release.resolve();
        await acceptedEntered.promise;
        expect(subagentRuns.size, "accepted local run still awaits source registration").toBe(0);
        expect(childController?.controller.signal.aborted).toBe(false);
      }
      if (closure === "native abort" || closure === "native acceptance") {
        const reply = await invokeChatAbortHandler({
          handler: handleChatAbortRequest,
          context,
          request: { sessionKey: parentSessionKey, runId: parentRunId },
          client: {
            connId: "owner-connection",
            connect: { scopes: ["operator.read", "operator.write"] },
          },
        });
        expect(reply).toHaveBeenCalledWith(true, {
          ok: true,
          aborted: true,
          runIds: [parentRunId],
        });
        expect(parent.controller.signal.aborted).toBe(true);
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
        expect(await wrappedOutcome).toBeInstanceOf(Error);
      } else {
        if (closure.endsWith("claim loss")) {
          releaseAgentRunDelegatedAuthority(authority);
        } else if (closure.endsWith("replacement")) {
          replacementAuthority = claimAgentRunDelegatedAuthority(
            createOperationalRunInstanceRef(parentRunId),
          );
        } else if (closure.endsWith("lifecycle rotation")) {
          rotateAgentRunRegistryLifecycleGeneration();
        } else if (closure === "projected close") {
          host!.close();
        } else if (closure.endsWith("signal")) {
          invocationAbort.abort();
        } else {
          admission.close();
        }
        expect(
          parent.controller.signal.aborted,
          "claim/capability closure is independent of parent signal",
        ).toBe(false);
      }
      release.resolve();
      acceptedGate.resolve();
      await forwarded;
      if (closure === "native acceptance") {
        expect(agentDispatch).toHaveBeenCalledOnce();
        expect(
          childController?.controller.signal.aborted,
          "exact accepted local child aborted before deletion",
        ).toBe(true);
      } else {
        expect(agentDispatch, "cancelled source never dispatches a child").not.toHaveBeenCalled();
      }
      expect(subagentRuns.size, "cancelled source never registers runnable work").toBe(0);
      const closedBeforePreparation =
        closure === "native engine resolution" || hasThread || hasAttachments;
      if (closedBeforePreparation) {
        expect
          .soft(prepare, "closed source must not start context engine preparation")
          .not.toHaveBeenCalled();
        expect.soft(rollback).not.toHaveBeenCalled();
      } else {
        expect(rollback).toHaveBeenCalledOnce();
      }
      if (closure === "native thread binding") {
        expect.soft(bindingFixture!.bind).not.toHaveBeenCalled();
      }
      if (closure === "native attachment staging") {
        expect(bindingFixture!.bind).toHaveBeenCalledOnce();
      }
      expect
        .soft(attachmentFixture?.lateWrites ?? [], "no new attachment write after parent closure")
        .toEqual([]);
      expect(bindingFixture?.bindings ?? []).toEqual([]);
      for (const directory of attachmentFixture?.attachmentDirs ?? []) {
        await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(deleted).toEqual([childSessionKey]);
      expect(loadSessionEntry({ storePath, sessionKey: childSessionKey })).toBeUndefined();
      const survivor = vi.fn(async () => {});
      enqueueSwarmRun({
        groupId: JSON.stringify(["main", parentSessionKey, groupId]),
        runId: "surviving-reservation",
        maxConcurrent: 1,
        activeRunIds: [],
        start: survivor,
        onStartFailure: () => true,
      });
      await vi.waitFor(() => expect(survivor).toHaveBeenCalledOnce());
    } finally {
      release.resolve();
      acceptedGate.resolve();
      await forwarded;
      childController?.cleanup();
      await wrappedOutcome;
      host?.close();
      if (replacementAuthority) {
        releaseAgentRunDelegatedAuthority(replacementAuthority);
      }
      admission.close();
      parent.cleanup();
      attachmentFixture?.restore();
      bindingFixture?.unregister();
    }
  });
});

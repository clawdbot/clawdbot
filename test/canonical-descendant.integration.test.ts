import http from "node:http";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginRuntimeMock,
  createPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexPlugin from "../extensions/codex/index.js";
import { createCanonicalForkFixtureForTest } from "../extensions/codex/test-api.js";
import openaiPlugin from "../extensions/openai/index.js";
import {
  prepareAgentRunAdmission,
  createOperationalRunInstanceRef,
} from "../src/agents/admitted-run-context.js";
import { retireSessionMcpRuntime } from "../src/agents/agent-bundle-mcp-manager-api.js";
import {
  setRuntimeAuthProfileStoreSnapshot,
  clearRuntimeAuthProfileStoreSnapshots,
} from "../src/agents/auth-profiles/runtime-snapshots.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../src/agents/harness/hook-helpers.js";
import { createAgentHarnessHostCapabilities } from "../src/agents/harness/host-capability.js";
import { listRegisteredAgentHarnesses } from "../src/agents/harness/registry.js";
import { withGatewayToolCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  loadTranscriptEvents,
  readClosedTranscriptTurn,
  replaceTranscriptEvents,
} from "../src/config/sessions/session-accessor.js";
import { writeSessionEntry } from "../src/config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { sessionRewindHandlers } from "../src/gateway/server-methods/sessions-rewind.js";
import type { GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import { createWorkerSessionPlacementStore } from "../src/gateway/worker-environments/placement-store.js";
import { readCodexSessionTranscriptEventsBeforeAdmission } from "../src/plugin-sdk/codex-session-transcript-runtime.js";
import { appendSessionTranscriptMessagesByIdentity } from "../src/plugin-sdk/session-transcript-runtime.js";
import {
  createPluginStateSyncKeyedStore,
  type OpenKeyedStoreOptions,
} from "../src/plugin-state/plugin-state-store.js";
import { resolvePluginMetadataSnapshot } from "../src/plugins/plugin-metadata-snapshot.js";
import {
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../src/plugins/registry-lifecycle.js";
import { withPluginRuntimeGenerationScope } from "../src/plugins/runtime/generation-scope.js";
import { setPluginRuntimeLoadContext } from "../src/plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../src/plugins/runtime/load-context.resolve.js";
import { createRuntimeAgent } from "../src/plugins/runtime/runtime-agent.js";
import { createPluginRecord } from "../src/plugins/status.test-helpers.js";
import type { OpenClawPluginMcpServerConnectionResolver } from "../src/plugins/types.js";
import {
  listSessionStateEventsSince,
  registerSessionStateWatch,
} from "../src/sessions/session-state-events.js";
import { readSessionUpstreamLink } from "../src/sessions/session-upstream-links.js";
import { runSessionUpstreamMonitorTick } from "../src/sessions/session-upstream-monitor.test-support.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../src/sessions/user-turn-transcript.js";
import { runOpenClawAgentWriteTransaction } from "../src/state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

type CanonicalForkFixture = Awaited<ReturnType<typeof createCanonicalForkFixtureForTest>>;

function expectPolicyHandoff(
  calls: CanonicalForkFixture["native"]["calls"],
  threadId: string,
  body: unknown,
) {
  if (typeof body !== "string") {
    throw new Error("Expected the complete generic policy, including an explicit empty body");
  }
  const refreshes = calls.filter((call) => call.method === "thread/inject_items");
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0]?.params).toEqual({
    threadId,
    items: [
      {
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: expect.stringContaining(body || "current OpenClaw generic policy is empty"),
          },
        ],
      },
    ],
  });
}

async function withFixture(
  run: (
    fixture: CanonicalForkFixture,
    fork: (
      key: string,
      entryId: string,
    ) => Promise<{ ok: boolean; key?: string; message?: string }>,
    revoke: (target: "source" | "child" | "registry", sourceKey: string) => void,
    admissions: Array<{ recorder: UserTurnTranscriptRecorder; before: unknown[] }>,
    runtime: ReturnType<typeof createPluginRuntimeMock>,
  ) => Promise<void>,
  options: {
    loading?: "searchable" | "direct";
    codexPlugins?: Parameters<typeof createCanonicalForkFixtureForTest>[0]["codexPlugins"];
    desktopGenerationFingerprint?: string;
    senderIsOwner?: boolean;
    mcpResolver?: OpenClawPluginMcpServerConnectionResolver;
  } = {},
) {
  await withOpenClawTestState({ label: "canonical-descendant" }, async (state) => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { model: { primary: "openai/gpt-5.5" } },
        list: [{ id: "main", agentDir: state.agentDir(), workspace: state.workspaceDir }],
      },
      tools: { web: { search: { enabled: false } } },
      ...(options.mcpResolver
        ? {
            mcp: {
              servers: { [options.mcpResolver.serverName]: { transport: "streamable-http" } },
            },
          }
        : {}),
    };
    setRuntimeAuthProfileStoreSnapshot({ version: 1, profiles: {} }, state.agentDir());
    const runtime = createPluginRuntimeMock({
      agent: createRuntimeAgent(),
      config: { current: () => config },
      state: {
        openSyncKeyedStore: <T>(storeOptions: OpenKeyedStoreOptions) =>
          createPluginStateSyncKeyedStore<T>("codex", storeOptions),
      },
    });
    const admissions: Array<{ recorder: UserTurnTranscriptRecorder; before: unknown[] }> = [];
    const fixture = await createCanonicalForkFixtureForTest({
      runtime,
      config,
      ...options,
      workspaceDir: state.workspaceDir,
      agentDir: state.agentDir(),
      createHost: async ({
        sessionId,
        sessionKey,
        runId,
        storePath,
        prompt,
        senderIsOwner,
        senderId,
        workerOwned,
      }) => {
        const abortController = new AbortController();
        let successor: ReturnType<typeof prepareAgentRunAdmission> | undefined;
        const target = { agentId: "main", sessionId, sessionKey, storePath };
        const recorder = createUserTurnTranscriptRecorder({
          input: {
            text: prompt,
            timestamp: 123,
            idempotencyKey: buildRunUserTurnIdempotencyKey(runId),
            senderIsOwner,
            sender: { id: senderId ?? "operator", name: "Operator" },
            transport: { channel: "webchat", messageId: "incoming" },
          },
          target: { ...target, sessionEntry: loadSessionEntry(target), config },
          beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        });
        await recorder.persistApproved();
        admissions.push({ recorder, before: structuredClone(await loadTranscriptEvents(target)) });
        const admission = prepareAgentRunAdmission({
          cfg: config,
          facts: {
            runId,
            agentId: "main",
            ingress: { kind: "system", boundary: "canonical-descendant-test", state: "present" },
          },
          operationalRunInstance: createOperationalRunInstanceRef(runId),
        });
        const admittedRunContext = await admission.admit("plugin-harness", runId);
        const placements = workerOwned ? createWorkerSessionPlacementStore() : undefined;
        let workerClaim: ReturnType<NonNullable<typeof placements>["claimTurn"]> | undefined;
        if (placements) {
          let placement = placements.startDispatch(target);
          placement = placements.transition({
            sessionId,
            from: "requested",
            to: "provisioning",
            expectedGeneration: placement.generation,
            patch: { environmentId: "policy-worker" },
          });
          placement = placements.transition({
            sessionId,
            from: "provisioning",
            to: "syncing",
            expectedGeneration: placement.generation,
            patch: { workerBundleHash: "a".repeat(64) },
          });
          placement = placements.transition({
            sessionId,
            from: "syncing",
            to: "starting",
            expectedGeneration: placement.generation,
            patch: {
              workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
              remoteWorkspaceDir: "/workspace/policy",
            },
          });
          placements.transition({
            sessionId,
            from: "starting",
            to: "active",
            expectedGeneration: placement.generation,
            patch: { activeOwnerEpoch: 7 },
          });
          workerClaim = placements.claimTurn({
            ...target,
            runId,
            claimId: "policy-claim",
            owner: { kind: "worker", environmentId: "policy-worker", ownerEpoch: 7 },
          });
        }
        const capturedWorkerClaim = workerClaim;
        const host = await withGatewayToolCallerIdentity(
          capturedWorkerClaim && placements
            ? {
                agentId: "main",
                sessionKey,
                operationalRunInstance: admittedRunContext.operationalRunInstance,
                workerTurnClaim: capturedWorkerClaim,
                receiptAuthority: () => placements.validateTurnClaim(capturedWorkerClaim),
              }
            : undefined,
          () =>
            createAgentHarnessHostCapabilities({
              pluginId: "codex",
              attempt: {
                agentId: "main",
                sessionId,
                sessionKey,
                runId,
                config,
                cwd: state.workspaceDir,
                workspaceDir: state.workspaceDir,
                admittedRunContext,
                abortSignal: abortController.signal,
                userTurnTranscriptRecorder: recorder,
                sessionTarget: target,
                senderIsOwner,
                senderId,
                githubPublicationAvailable: false,
              },
            }),
        );
        return {
          ...host,
          abortController,
          invalidate: async (reason) => {
            if (reason === "claim") {
              if (capturedWorkerClaim) {
                placements?.releaseTurn(capturedWorkerClaim);
              }
              workerClaim = undefined;
            } else if (reason === "aborted") {
              abortController.abort();
            } else if (reason === "closed") {
              host.close();
            } else {
              successor = prepareAgentRunAdmission({
                cfg: config,
                facts: {
                  runId,
                  agentId: "main",
                  ingress: {
                    kind: "system",
                    boundary: "canonical-descendant-test",
                    state: "present",
                  },
                },
                operationalRunInstance: createOperationalRunInstanceRef(runId),
              });
              await successor.admit("plugin-harness", runId);
            }
          },
          userTurnTranscriptRecorder: recorder,
          close: () => {
            host.close();
            if (workerClaim) {
              placements?.releaseTurn(workerClaim);
            }
            admission.close();
            successor?.close();
          },
        };
      },
    });
    config.plugins = {
      allow: ["codex", "openai"],
      entries: {
        codex: { enabled: true, config: fixture.pluginConfig },
        openai: { enabled: true },
      },
    };
    const { registry, createApi } = createPluginRegistry({
      runtime,
      logger: { info() {}, warn() {}, error() {} },
      activateGlobalSideEffects: false,
    });
    const metadataSnapshot = resolvePluginMetadataSnapshot({
      config,
      workspaceDir: state.workspaceDir,
      preferPersisted: false,
    });
    for (const plugin of [codexPlugin, openaiPlugin]) {
      const rootDir = fileURLToPath(new URL(`../extensions/${plugin.id}/`, import.meta.url));
      const record = createPluginRecord({
        id: plugin.id,
        contracts: expectDefined(metadataSnapshot.byPluginId.get(plugin.id), "plugin manifest")
          .contracts,
        origin: "bundled",
        rootDir,
        source: `${rootDir}index.ts`,
      });
      registry.plugins.push(record);
      plugin.register(
        createApi(record, {
          config,
          pluginConfig: config.plugins.entries?.[plugin.id]?.config,
        }),
      );
    }
    if (options.mcpResolver) {
      const record = createPluginRecord({ id: "canonical-requester-mcp" });
      registry.plugins.push(record);
      createApi(record, { config }).registerMcpServerConnectionResolver(options.mcpResolver);
    }
    expect(registry.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
    markPluginRegistryActive(registry);
    setPluginRuntimeLoadContext(
      registry,
      resolvePluginRuntimeLoadContext({
        config,
        workspaceDir: state.workspaceDir,
        metadataSnapshot,
      }),
    );
    const fork = async (sessionKey: string, entryId: string) => {
      expect(
        listRegisteredAgentHarnesses().map((entry) => entry.harness.sessionFork?.upstreamKinds),
      ).toEqual([["codex-app-server"]]);
      let result: { ok: boolean; key?: string; message?: string } | undefined;
      const request = { sessionKey, entryId };
      await expectDefined(
        sessionRewindHandlers["sessions.fork"],
        "fork handler",
      )({
        req: { type: "req", id: "canonical-descendant", method: "sessions.fork", params: request },
        params: request,
        client: null,
        isWebchatConnect: () => false,
        // SAFETY: these are the complete Gateway collaborators used by the real fork handler.
        context: {
          getRuntimeConfig: () => config,
          chatAbortControllers: new Map(),
          getSessionEventSubscriberConnIds: () => new Set(),
          broadcastToConnIds: () => {},
        } as unknown as GatewayRequestContext,
        respond: (ok, payload, error) => {
          const key =
            payload &&
            typeof payload === "object" &&
            "sessionKey" in payload &&
            typeof payload.sessionKey === "string"
              ? payload.sessionKey
              : undefined;
          result = { ok, key, ...(error ? { message: error.message } : {}) };
        },
      });
      return expectDefined(result, "fork response");
    };
    try {
      await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: registry }, () =>
        run(
          fixture,
          fork,
          (target, sourceKey) => {
            if (target === "registry") {
              markPluginRegistryRetired(registry);
              return;
            }
            const key =
              target === "source"
                ? sourceKey
                : expectDefined(
                    listSessionEntriesCore({
                      agentId: "main",
                      storePath: fixture.storePath,
                    }).find(({ entry }) => entry.initializationPending === true)?.sessionKey,
                    "pending child",
                  );
            const entry = expectDefined(
              loadSessionEntry({ sessionKey: key, storePath: fixture.storePath }),
              "revoked owner",
            );
            runOpenClawAgentWriteTransaction(
              (database) =>
                writeSessionEntry(database, key, {
                  ...entry,
                  lifecycleRevision: "successor-generation",
                }),
              { agentId: "main" },
            );
          },
          admissions,
          runtime,
        ),
      );
    } finally {
      if (options.mcpResolver) {
        for (const { entry } of listSessionEntriesCore({
          agentId: "main",
          storePath: fixture.storePath,
        })) {
          await retireSessionMcpRuntime({
            sessionId: entry.sessionId,
            reason: "canonical requester fixture complete",
          });
        }
      }
      markPluginRegistryRetired(registry);
      await fixture.dispose();
    }
  });
}

describe("canonical descendant lifecycle through real owners", () => {
  it("refreshes each supervised cold context with the complete final body and no extra user history", async () => {
    await withFixture(async (fixture, _fork, _revoke, admissions) => {
      const source = await fixture.adopt();
      const bodies = [
        "initial policy",
        "full policy\n" + "long policy section\n".repeat(1600),
        "replacement with removed sections",
        "",
      ];
      const binding = await fixture.turn(source.sessionKey, "first", {
        developerInstructions: bodies[0],
      });
      for (const body of bodies.slice(1)) {
        await fixture.native.restart();
        const offset = fixture.native.calls.length;
        const resumed = await fixture.turn(source.sessionKey, "next", {
          developerInstructions: body,
        });
        expect(resumed.threadId).toBe(binding.threadId);
        const calls = fixture.native.calls.slice(offset);
        const resume = expectDefined(
          calls.find((call) => call.method === "thread/resume"),
          "cold configuration",
        );
        expect(resume.params.developerInstructions).toBe(body);
        expectPolicyHandoff(calls, binding.threadId, body);
        expect(calls.findIndex((call) => call.method === "thread/inject_items")).toBeLessThan(
          calls.findIndex((call) => call.method === "turn/start"),
        );
        expect(
          admissions.at(-1)?.recorder.getPersistedMessage?.()?.["__openclaw"]?.mirrorIdentity,
        ).toMatch(/:prompt$/);
      }
      expect(
        (await fixture.readEntries(source.sessionKey)).filter((entry) => entry.role === "user"),
      ).toHaveLength(6);
      expect(fixture.native.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    });
  }, 180_000);

  it.each(["rpc", "disconnect"] as const)(
    "preserves an existing binding and admission after uncertain policy %s without startup replay",
    async (fault) => {
      await withFixture(async (fixture, _fork, _revoke, admissions) => {
        const source = await fixture.adopt();
        const binding = await fixture.turn(source.sessionKey, "accepted");
        const before = fixture.bindingStore.read(fixture.identity(source.sessionKey));
        const offset = fixture.native.calls.length;
        const history = structuredClone(fixture.native.threads.get(binding.threadId)?.thread.turns);
        fixture.native.setPolicyFault(fault);
        await expect(
          fixture.turn(source.sessionKey, "not accepted", {
            developerInstructions: "changed session configuration",
          }),
        ).rejects.toThrow(/policy handoff failed/);
        const calls = fixture.native.calls.slice(offset);
        expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
        expect(calls.filter((call) => call.method === "thread/inject_items")).toHaveLength(1);
        expect(
          calls.some((call) =>
            ["thread/start", "thread/fork", "thread/archive", "turn/start"].includes(call.method),
          ),
        ).toBe(false);
        expect(fixture.bindingStore.read(fixture.identity(source.sessionKey))).toEqual(before);
        expect(fixture.native.threads.get(binding.threadId)?.thread.turns).toEqual(history);
        expect(
          admissions.at(-1)?.recorder.getPersistedMessage?.()?.["__openclaw"],
        ).not.toHaveProperty("mirrorIdentity");
        const lastClient = calls.find((call) => call.method === "thread/inject_items")?.client;
        // A separately admitted cold run may reassert once on a new physical client.
        await fixture.turn(source.sessionKey, "independent retry");
        expect(
          fixture.native.calls.findLast((call) => call.method === "thread/resume")?.client,
        ).not.toBe(lastClient);
        expect(fixture.native.threads.has("original")).toBe(true);
      });
    },
    180_000,
  );

  it.each(["rpc", "disconnect"] as const)(
    "retains a non-ready fresh child after uncertain policy %s without unsafe archive",
    async (fault) => {
      await withFixture(async (fixture, fork) => {
        const source = await fixture.adopt();
        const binding = await fixture.turn(source.sessionKey, "accepted");
        const selected = (await fixture.readEntries(source.sessionKey)).at(-1)!;
        const before = fixture.bindingStore.read(fixture.identity(source.sessionKey));
        const offset = fixture.native.calls.length;
        const threads = new Set(fixture.native.threads.keys());
        fixture.native.setPolicyFault(fault);
        const result = await fork(source.sessionKey, selected.entryId);
        expect(result.ok).toBe(false);
        const calls = fixture.native.calls.slice(offset);
        expect(calls.filter((call) => call.method === "thread/fork")).toHaveLength(1);
        expect(calls.filter((call) => call.method === "thread/inject_items")).toHaveLength(1);
        expect(
          calls.some((call) => call.method === "thread/archive" || call.method === "turn/start"),
        ).toBe(false);
        expect([...fixture.native.threads.keys()].filter((id) => !threads.has(id))).toHaveLength(1);
        expect(
          listSessionEntriesCore({ agentId: "main", storePath: fixture.storePath }).some(
            ({ entry }) => entry.initializationPending === true,
          ),
        ).toBe(true);
        expect(fixture.bindingStore.read(fixture.identity(source.sessionKey))).toEqual(before);
        expect(fixture.native.threads.has(binding.threadId)).toBe(true);
        expect(fixture.native.threads.has("original")).toBe(true);
      });
    },
    180_000,
  );

  it.each(
    ["source", "child", "registry"].flatMap((target) =>
      ["prewrite", "overload", "acknowledged"].map((phase) => ({
        target: target as "source" | "child" | "registry",
        phase,
      })),
    ),
  )(
    "fences policy writes after $target revocation at $phase",
    async ({ target, phase }) => {
      await withFixture(async (fixture, fork, revoke) => {
        const source = await fixture.adopt();
        await fixture.turn(source.sessionKey, "accepted");
        const selected = (await fixture.readEntries(source.sessionKey)).at(-1)!;
        const before = fixture.native.calls.length;
        let restore: (() => void) | undefined;
        if (phase === "overload") {
          fixture.native.rejectNext("thread/inject_items", () => revoke(target, source.sessionKey));
        } else if (phase === "acknowledged") {
          fixture.native.setAfterPolicyWrite(() => revoke(target, source.sessionKey));
        } else {
          await fixture.withClient(async (client) => {
            const request = client.request.bind(client);
            const spy = vi.spyOn(client, "request").mockImplementation((method, input, options) => {
              if (method === "thread/inject_items") {
                revoke(target, source.sessionKey);
              }
              return request(method, input, options);
            });
            restore = () => spy.mockRestore();
          });
        }
        try {
          expect((await fork(source.sessionKey, selected.entryId)).ok).toBe(false);
        } finally {
          restore?.();
        }
        expect(
          fixture.native.calls
            .slice(before)
            .filter((call) => call.method === "thread/inject_items"),
        ).toHaveLength(phase === "prewrite" ? 0 : 1);
      });
    },
    180_000,
  );

  it.each(["resume", "fork"] as const)(
    "fails an acknowledged policy %s handoff on binding CAS without replay or source deletion",
    async (operation) => {
      await withFixture(async (fixture, fork) => {
        const source = await fixture.adopt();
        const binding = await fixture.turn(source.sessionKey, "accepted");
        const before = fixture.bindingStore.read(fixture.identity(source.sessionKey));
        const selected = (await fixture.readEntries(source.sessionKey)).at(-1)!;
        const mutate = fixture.bindingStore.mutate.bind(fixture.bindingStore);
        const spy = vi
          .spyOn(fixture.bindingStore, "mutate")
          .mockImplementation(async (...args) =>
            operation === "resume" && args[1].kind === "patch" ? false : await mutate(...args),
          );
        let successorKey: string | undefined;
        if (operation === "fork") {
          fixture.native.setAfterPolicyWrite(async () => {
            successorKey = expectDefined(
              listSessionEntriesCore({ agentId: "main", storePath: fixture.storePath }).find(
                ({ entry }) => entry.initializationPending === true,
              )?.sessionKey,
              "pending child",
            );
            expect(
              await mutate(fixture.identity(successorKey), {
                kind: "set",
                if: { kind: "absent" },
                binding: {
                  ...expectDefined(before, "source binding"),
                  threadId: "successor-thread",
                },
              }),
            ).toBe(true);
          });
        }
        const offset = fixture.native.calls.length;
        try {
          if (operation === "resume") {
            await expect(fixture.turn(source.sessionKey, "CAS failure")).rejects.toThrow(
              /policy handoff.*binding/i,
            );
          } else {
            expect((await fork(source.sessionKey, selected.entryId)).ok).toBe(false);
          }
        } finally {
          spy.mockRestore();
        }
        const calls = fixture.native.calls.slice(offset);
        expect(calls.filter((call) => call.method === "thread/inject_items")).toHaveLength(1);
        expect(calls.filter((call) => call.method === `thread/${operation}`)).toHaveLength(1);
        expect(
          calls.some((call) => call.method === "turn/start" || call.method === "thread/start"),
        ).toBe(false);
        expect(
          calls
            .filter((call) => call.method === "thread/archive")
            .every(
              (call) =>
                call.params.threadId !== binding.threadId && call.params.threadId !== "original",
            ),
        ).toBe(true);
        expect(fixture.bindingStore.read(fixture.identity(source.sessionKey))).toEqual(before);
        if (successorKey) {
          expect(fixture.bindingStore.read(fixture.identity(successorKey))).toMatchObject({
            threadId: "successor-thread",
          });
        }
      });
    },
    180_000,
  );

  it.each(
    (["closed", "aborted", "replaced", "claim"] as const).flatMap((reason) =>
      (["prewrite", "overload", "acknowledged"] as const).map((phase) => ({ reason, phase })),
    ),
  )(
    "fences a supervised policy handoff after run authority is $reason at $phase",
    async ({ reason, phase }) => {
      await withFixture(async (fixture) => {
        const source = await fixture.adopt();
        await fixture.turn(source.sessionKey, "accepted");
        const before = fixture.bindingStore.read(fixture.identity(source.sessionKey));
        const offset = fixture.native.calls.length;
        let restore: (() => void) | undefined;
        try {
          await expect(
            fixture.turn(source.sessionKey, "revoked", {
              workerOwned: reason === "claim",
              beforeStartup: async (invalidate) => {
                if (phase === "overload") {
                  fixture.native.rejectNext("thread/inject_items", () => invalidate(reason));
                } else if (phase === "acknowledged") {
                  fixture.native.setAfterPolicyWrite(() => invalidate(reason));
                } else {
                  await fixture.withClient(async (client) => {
                    const request = client.request.bind(client);
                    const spy = vi
                      .spyOn(client, "request")
                      .mockImplementation(async (method, input, options) => {
                        if (method === "thread/inject_items") {
                          await invalidate(reason);
                        }
                        return request(method, input, options);
                      });
                    restore = () => spy.mockRestore();
                  });
                }
              },
            }),
          ).rejects.toThrow(
            reason === "aborted" ? "codex app-server startup aborted" : /policy handoff/,
          );
        } finally {
          restore?.();
        }
        const calls = fixture.native.calls.slice(offset);
        expect(calls.filter((call) => call.method === "thread/inject_items")).toHaveLength(
          phase === "prewrite" ? 0 : 1,
        );
        expect(
          calls.some((call) => call.method === "turn/start" || call.method === "thread/start"),
        ).toBe(false);
        expect(fixture.bindingStore.read(fixture.identity(source.sessionKey))).toEqual(before);
      });
    },
    180_000,
  );

  it("leaves an old unannotated prefix refused despite matching assistant correlation and a later annotated turn", async () => {
    await withFixture(async (fixture, fork, _revoke, admissions) => {
      const source = await fixture.adopt();
      await fixture.turn(source.sessionKey, "repeated prompt");
      const target = {
        ...fixture.identity(source.sessionKey),
        sessionKey: source.sessionKey,
        storePath: fixture.storePath,
      };
      const first = expectDefined(
        admissions.at(-1)?.recorder.getAdmissionReceipt(),
        "first admission",
      );
      const recorded = await loadTranscriptEvents(target);
      const nativeMeta = (recorded.at(-1) as { message: { __openclaw: Record<string, unknown> } })
        .message["__openclaw"];
      // Model the observed pre-fix stored shape, not an inferred native-to-local mapping.
      await replaceTranscriptEvents(
        target,
        expectDefined(admissions.at(-1), "pre-fix admission").before,
      );
      await appendSessionTranscriptMessagesByIdentity({
        ...target,
        messages: [
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "matching reply" }],
              timestamp: 234,
              __openclaw: {
                mirrorIdentity: String(nativeMeta.mirrorIdentity).replace(":prompt", ":reply"),
                runId: nativeMeta.runId,
              },
            },
          },
        ],
      });
      await fixture.turn(source.sessionKey, "repeated prompt");
      const later = expectDefined(
        admissions.at(-1)?.recorder.getAdmissionReceipt(),
        "later admission",
      );
      expect(
        admissions.at(-1)?.recorder.getPersistedMessage?.()?.["__openclaw"]?.mirrorIdentity,
      ).toBeDefined();
      const before = await loadTranscriptEvents(target);
      const calls = fixture.native.calls.filter((call) => call.method === "thread/fork").length;
      expect(await fork(source.sessionKey, first.entryId)).toMatchObject({ ok: false });
      expect(await fork(source.sessionKey, later.entryId)).toMatchObject({ ok: false });
      expect(fixture.native.calls.filter((call) => call.method === "thread/fork")).toHaveLength(
        calls,
      );
      expect(await loadTranscriptEvents(target)).toEqual(before);
    });
  }, 180_000);

  it("annotates the pre-admitted Gateway user without replacing its event or read fence", async () => {
    await withFixture(async (fixture, fork, _revoke, admissions) => {
      const source = await fixture.adopt();
      for (const text of ["repeat", "repeat"]) {
        await fixture.turn(source.sessionKey, text);
        const { recorder, before } = admissions.at(-1)!;
        const admission = expectDefined(recorder.getAdmissionReceipt(), "current admission");
        const target = {
          ...fixture.identity(source.sessionKey),
          sessionKey: source.sessionKey,
          storePath: fixture.storePath,
        };
        const after = await loadTranscriptEvents(target);
        const added = after.at(-1) as {
          id: string;
          message: { __openclaw?: Record<string, unknown> };
        };
        expect(added.id).toBe(admission.entryId);
        expect(added.message["__openclaw"]).toMatchObject({
          mirrorOrigin: "codex-app-server",
          mirrorIdentity: expect.stringMatching(/:prompt$/),
          upstreamUserText: text,
          mirrorSourceFingerprint: expect.any(String),
        });
        const original = before.at(-1) as typeof added;
        const meta = { ...added.message["__openclaw"] };
        for (const key of [
          "mirrorIdentity",
          "upstreamUserText",
          "mirrorOrigin",
          "mirrorSourceFingerprint",
          "runId",
        ]) {
          delete meta[key];
        }
        expect({ ...added, message: { ...added.message, __openclaw: meta } }).toEqual(original);
        expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
        expect(recorder.getPersistedMessage?.()).toEqual(added.message);
        expect(await readCodexSessionTranscriptEventsBeforeAdmission(target, admission)).toEqual(
          before.slice(0, -1),
        );
        expect(
          readClosedTranscriptTurn({
            boundary: { admission, terminal: admission },
            maxEvents: 100,
            maxBytes: 100_000,
          }),
        ).toMatchObject({ kind: "ok", messages: [added.message] });
        expect(await fork(source.sessionKey, admission.entryId)).toMatchObject({ ok: true });
      }
    });
  }, 180_000);
  it.each(["source", "child", "registry"] as const)(
    "fences physical fork writes after %s revocation during configuration wait",
    async (target) => {
      await withFixture(async (fixture, fork, revoke) => {
        const source = await fixture.adopt();
        await fixture.turn(source.sessionKey, "canonical");
        const selected = (await fixture.readEntries(source.sessionKey)).at(-1)!;
        await fixture.withClient(async (client) => {
          const release = await fixture.holdConfiguration(client);
          const request = vi.spyOn(client, "request"); // Pass-through: the real fence still runs.
          const before = fixture.native.calls.filter(
            (call) => call.method === "thread/fork",
          ).length;
          const pending = fork(source.sessionKey, selected.entryId);
          let result: Awaited<ReturnType<typeof fork>>;
          try {
            await vi.waitFor(
              () =>
                expect(request.mock.calls.some(([method]) => method === "thread/fork")).toBe(true),
              { timeout: 10_000 },
            );
            expect(
              fixture.native.calls.filter((call) => call.method === "thread/fork"),
            ).toHaveLength(before);
            revoke(target, source.sessionKey);
          } finally {
            release();
            result = await pending;
            request.mockRestore();
          }
          expect(result.ok).toBe(false);
          expect(fixture.native.calls.filter((call) => call.method === "thread/fork")).toHaveLength(
            before,
          );
          await fixture.withClient(async (next) => {
            expect(next).toBe(client);
          });
          await expect(client.request("config/read", {})).resolves.toMatchObject({ config: {} });
        });
      });
    },
    180_000,
  );

  it.each(["source", "child", "registry"] as const)(
    "fences physical fork retries after %s revocation on overload",
    async (target) => {
      await withFixture(async (fixture, fork, revoke) => {
        const source = await fixture.adopt();
        await fixture.turn(source.sessionKey, "canonical");
        const selected = (await fixture.readEntries(source.sessionKey)).at(-1)!;
        const before = fixture.native.calls.filter((call) => call.method === "thread/fork").length;
        fixture.native.rejectNext("thread/fork", () => revoke(target, source.sessionKey));
        await fixture.withClient(async (client) => {
          const result = await fork(source.sessionKey, selected.entryId);
          expect(result.ok).toBe(false);
          expect(fixture.native.calls.filter((call) => call.method === "thread/fork")).toHaveLength(
            before + 1,
          );
          await fixture.withClient(async (next) => {
            expect(next).toBe(client);
          });
        });
      });
    },
    180_000,
  );

  it.each(["source", "registry"] as const)(
    "fences native archive retries after %s rollback authority is revoked",
    async (target) => {
      await withFixture(async (fixture, fork, revoke) => {
        const source = await fixture.adopt();
        const binding = await fixture.turn(source.sessionKey, "canonical");
        const selected = (await fixture.readEntries(source.sessionKey)).at(-1)!;
        const before = new Set(fixture.native.threads.keys());
        const archiveCount = fixture.native.calls.filter(
          (call) => call.method === "thread/archive",
        ).length;
        fixture.native.setForkFault("model");
        fixture.native.rejectNext("thread/archive", () => revoke(target, source.sessionKey));
        expect((await fork(source.sessionKey, selected.entryId)).ok).toBe(false);
        expect(
          fixture.native.calls.filter((call) => call.method === "thread/archive"),
        ).toHaveLength(archiveCount + 1);
        expect([...fixture.native.threads.keys()].filter((id) => !before.has(id))).toHaveLength(1);
        expect(fixture.native.threads.has(binding.threadId)).toBe(true);
        expect(fixture.native.threads.has("original")).toBe(true);
      });
    },
    180_000,
  );

  it.each(["source", "child", "registry"] as const)(
    "retires the exact subscription after %s revocation following native fork without killing sibling leases",
    async (target) => {
      await withFixture(async (fixture, fork, revoke) => {
        const source = await fixture.adopt();
        const binding = await fixture.turn(source.sessionKey, "canonical");
        const selected = (await fixture.readEntries(source.sessionKey)).at(-1)!;
        const archiveCount = fixture.native.calls.filter(
          (call) => call.method === "thread/archive",
        ).length;
        let fresh: string | undefined;
        fixture.native.setAfterFork((threadId) => {
          fresh = threadId;
          revoke(target, source.sessionKey);
        });
        await fixture.withClient(async (client) => {
          expect((await fork(source.sessionKey, selected.entryId)).ok).toBe(false);
          expect(fresh).toBeTruthy();
          expect(
            fixture.native.calls.filter((call) => call.method === "thread/archive"),
          ).toHaveLength(archiveCount);
          await expect(client.request("config/read", {})).resolves.toMatchObject({ config: {} });
          await fixture.withClient(async (next) => {
            expect(next).not.toBe(client);
          });
          expect(fixture.native.threads.has(binding.threadId)).toBe(true);
          expect(fixture.native.threads.has("original")).toBe(true);
          expect(fixture.native.threads.has(fresh!)).toBe(true);
        });
        await vi.waitFor(() =>
          expect([...fixture.native.subscriptions].some((key) => key.endsWith(`:${fresh}`))).toBe(
            false,
          ),
        );
      });
    },
    180_000,
  );

  it("keeps ordinary archive cleanup on the healthy client while its notification is delayed", async () => {
    await withFixture(async (fixture, fork) => {
      const source = await fixture.adopt();
      await fixture.turn(source.sessionKey, "canonical");
      const selected = (await fixture.readEntries(source.sessionKey)).at(-1)!;
      const before = [...fixture.native.threads.keys()];
      fixture.native.setForkFault("model");
      const releaseNotifications = fixture.native.holdArchiveNotifications();
      try {
        await fixture.withClient(async (client) => {
          expect((await fork(source.sessionKey, selected.entryId)).ok).toBe(false);
          expect([...fixture.native.threads.keys()]).toEqual(before);
          await fixture.withClient(async (next) => {
            expect(next).toBe(client);
          });
        });
      } finally {
        releaseNotifications();
      }
    });
  });

  it("baselines the verified retained native prefix beyond the monitor dedupe window and detects later native input", async () => {
    await withFixture(async (fixture, fork) => {
      const source = await fixture.adopt();
      for (let index = 0; index < 13; index++) {
        await fixture.turn(source.sessionKey, `canonical ${index}`);
      }
      const selected = (await fixture.readEntries(source.sessionKey)).at(-1)!;
      const result = await fork(source.sessionKey, selected.entryId);
      expect(result, result.message).toMatchObject({ ok: true });
      const key = expectDefined(result.key, "child");
      const binding = expectDefined(
        fixture.bindingStore.read(fixture.identity(key)),
        "child binding",
      );
      const child = expectDefined(fixture.native.threads.get(binding.threadId), "native child");
      expect(child.thread.turns).toHaveLength(12);
      registerSessionStateWatch({ watcherSessionKey: "agent:main:main", targetSessionKey: key });
      const events = () => listSessionStateEventsSince(key, "main", 0).events;
      const before = events();
      await runSessionUpstreamMonitorTick({ providers: [fixture.catalog] });
      expect(events()).toEqual(before);
      const link = expectDefined(readSessionUpstreamLink(key, "main"), "child link");
      const root = expectDefined(readSessionUpstreamLink(source.sessionKey, "main"), "root link");
      expect(link).toMatchObject({
        threadId: root.threadId,
        upstreamRef: root.upstreamRef,
        marker: { turnId: child.thread.turns!.at(-1)!.id, userMessageCount: 1 },
      });
      await fixture.withClient(async (client) => {
        await client.request("thread/resume", { threadId: binding.threadId }, { timeoutMs: 5_000 });
        await client.request("turn/start", {
          threadId: binding.threadId,
          input: [{ type: "text", text: "genuine native input", text_elements: [] }],
        });
      });
      await runSessionUpstreamMonitorTick({ providers: [fixture.catalog] });
      expect(events().slice(before.length)).toEqual([
        expect.objectContaining({ kind: "human_direct_message" }),
      ]);
      await runSessionUpstreamMonitorTick({ providers: [fixture.catalog] });
      expect(events()).toHaveLength(before.length + 1);
    });
  }, 180_000);

  it("forks with the current native model instead of the stale persisted model", async () => {
    await withFixture(async (fixture, fork) => {
      const source = await fixture.adopt();
      const binding = await fixture.turn(source.sessionKey, "canonical");
      const current = expectDefined(fixture.native.threads.get(binding.threadId), "canonical");
      current.thread.model = "gpt-5.5";
      const selected = (await fixture.readEntries(source.sessionKey)).at(-1)!;
      const result = await fork(source.sessionKey, selected.entryId);
      expect(result, result.message).toMatchObject({ ok: true });
      const childKey = expectDefined(result.key, "child key");
      expect(fixture.bindingStore.read(fixture.identity(childKey))).toMatchObject({
        model: "gpt-5.5",
        modelProvider: current.thread.modelProvider,
      });
      expect(current.model).toBe("gpt-5.6-luna");
    });
  }, 180_000);

  it.each([
    ...(["searchable", "direct"] as const).flatMap((loading) =>
      (["unconfigured", "empty", "disabled", "enabled"] as const).map((appPolicy) => ({
        loading,
        appPolicy,
        runtime: "custom",
      })),
    ),
    { loading: "searchable", appPolicy: "disabled", runtime: "managed desktop" } as const,
  ])(
    "forks first/later canonical turns without reimporting user history, preserves root provenance after source loss, and forks a restarted descendant again ($loading, apps $appPolicy, $runtime)",
    async ({ loading, appPolicy, runtime }) => {
      await withFixture(
        async (fixture, fork) => {
          const source = await fixture.adopt();
          const canonical = await fixture.turn(source.sessionKey, "repeat");
          await fixture.turn(source.sessionKey, "repeat");
          const originalState = structuredClone(fixture.native.source);
          const current = expectDefined(
            fixture.native.threads.get(canonical.threadId),
            "canonical native thread",
          );
          const currentBefore = structuredClone(current);
          const entries = await fixture.readEntries(source.sessionKey);
          const users = entries.filter((entry) => entry.role === "user");
          expect(users).toHaveLength(4);
          expect(current.rawPrefix).toHaveLength(3);
          expect(canonical.model).toBe("gpt-5.6-luna");
          const injections = fixture.native.calls.filter(
            (call) =>
              call.method === "thread/inject_items" &&
              Array.isArray(call.params.items) &&
              call.params.items.some((item: { role?: string }) => item.role === "user"),
          ).length;
          const turnsBeforeFork = fixture.native.calls.filter(
            (call) => call.method === "turn/start",
          ).length;
          const firstForkOffset = fixture.native.calls.length;
          const first = await fork(source.sessionKey, users[2]!.entryId);
          expect(first, first.message).toMatchObject({ ok: true });
          expect(fixture.native.calls.filter((call) => call.method === "turn/start")).toHaveLength(
            turnsBeforeFork,
          );
          const firstKey = expectDefined(first.key, "first descendant key");
          const firstBinding = expectDefined(
            fixture.bindingStore.read(fixture.identity(firstKey)),
            "first descendant binding",
          );
          const firstForkCalls = fixture.native.calls.slice(firstForkOffset);
          const forked = expectDefined(
            firstForkCalls.find((call) => call.method === "thread/fork"),
            "canonical fork request",
          );
          expectPolicyHandoff(
            firstForkCalls,
            firstBinding.threadId,
            forked.params.developerInstructions,
          );
          const nativeFirst = expectDefined(
            fixture.native.threads.get(firstBinding.threadId),
            "first descendant",
          );
          expect(nativeFirst.thread.turns).toEqual([]);
          expect(nativeFirst.rawPrefix.slice(0, -1)).toEqual(currentBefore.rawPrefix);
          expect(nativeFirst.rawPrefix.at(-1)).toMatchObject({ role: "developer" });
          expect(firstBinding).not.toHaveProperty("pendingSupervisionBranch");
          expect(firstBinding.nativeHookRelayGeneration).toBeTruthy();
          expect(
            [...fixture.native.subscriptions].some((key) =>
              key.endsWith(`:${firstBinding.threadId}`),
            ),
          ).toBe(false);
          const link = readSessionUpstreamLink(source.sessionKey, "main");
          expect(readSessionUpstreamLink(firstKey, "main")).toMatchObject({
            threadId: link?.threadId,
            marker: { turnId: null, userMessageCount: 0 },
          });
          const firstEntries = await fixture.readEntries(firstKey);
          expect(firstEntries.map((entry) => entry.message)).toEqual(
            entries.slice(0, 2).map((entry) => entry.message),
          );
          expect(
            firstEntries.every(
              (entry) => !entries.some((sourceEntry) => sourceEntry.entryId === entry.entryId),
            ),
          ).toBe(true);
          const inherited = structuredClone(nativeFirst.dynamicTools);
          const unavailable = async ({
            bridge,
          }: Parameters<
            NonNullable<NonNullable<Parameters<typeof fixture.turn>[2]>["inspectTools"]>
          >[0]) => {
            expect(bridge.specs).toEqual(inherited);
            expect(bridge.availableTools.some((tool) => tool.name === "codex_threads")).toBe(false);
            const calls = fixture.native.calls.length;
            const result = await bridge.handleToolCall({
              threadId: firstBinding.threadId,
              turnId: "current",
              callId: "unavailable-owner",
              namespace: null,
              tool: "codex_threads",
              arguments: { action: "list" },
            });
            expect(result.success).toBe(false);
            expect(result.executionStarted, JSON.stringify(result.contentItems)).toBe(false);
            expect(JSON.stringify(result.contentItems)).toContain("not available for this turn");
            expect(fixture.native.calls).toHaveLength(calls);
          };
          await fixture.native.restart();
          const firstResumeCalls = fixture.native.calls.length;
          expect(
            (
              await fixture.turn(firstKey, "first nonowner turn", {
                senderIsOwner: false,
                inspectTools: unavailable,
              })
            ).threadId,
          ).toBe(firstBinding.threadId);
          const resumed = expectDefined(
            fixture.native.calls
              .slice(firstResumeCalls)
              .find((call) => call.method === "thread/resume"),
            "cold first child resume",
          );
          expect(resumed.params.threadId).toBe(firstBinding.threadId);
          const expectedApps =
            appPolicy === "unconfigured"
              ? undefined
              : {
                  _default: {
                    enabled: false,
                    destructive_enabled: false,
                    open_world_enabled: false,
                  },
                  ...(appPolicy === "enabled"
                    ? {
                        "synthetic-app": {
                          enabled: true,
                          destructive_enabled: false,
                          open_world_enabled: true,
                          default_tools_approval_mode: "auto",
                        },
                      }
                    : {}),
                };
          for (const request of [forked, resumed]) {
            if (expectedApps) {
              expect(request.params.config).toHaveProperty("apps", expectedApps);
            } else {
              expect(request.params.config).not.toHaveProperty("apps");
            }
          }
          for (const binding of [canonical, firstBinding]) {
            expect(Boolean(binding.pluginAppsFingerprint)).toBe(appPolicy !== "unconfigured");
            expect(Boolean(binding.pluginAppsInputFingerprint)).toBe(appPolicy !== "unconfigured");
            expect(binding.pluginAppPolicyContext?.apps).toEqual(
              appPolicy === "unconfigured"
                ? undefined
                : appPolicy !== "enabled"
                  ? {}
                  : {
                      "synthetic-app": {
                        source: "account",
                        appName: "Synthetic App",
                        allowDestructiveActions: false,
                        allowOpenWorld: true,
                        destructiveApprovalMode: "deny",
                        mcpServerNames: [],
                      },
                    },
            );
          }
          for (const reason of ["closed", "aborted", "replaced"] as const) {
            expect(
              (
                await fixture.turn(firstKey, `owner ${reason}`, {
                  senderIsOwner: true,
                  inspectTools: async ({ bridge, invalidate }) => {
                    expect(bridge.specs).toEqual(inherited);
                    expect(
                      bridge.availableTools.some((tool) => tool.name === "codex_threads"),
                    ).toBe(true);
                    await invalidate(reason);
                    const calls = fixture.native.calls.length;
                    const result = await bridge.handleToolCall({
                      threadId: firstBinding.threadId,
                      turnId: "current",
                      callId: `revoked-${reason}`,
                      namespace: null,
                      tool: "codex_threads",
                      arguments: { action: "list" },
                    });
                    expect(result.success).toBe(false);
                    expect(result.executionStarted, JSON.stringify(result.contentItems)).toBe(
                      false,
                    );
                    expect(fixture.native.calls).toHaveLength(calls);
                  },
                })
              ).threadId,
            ).toBe(firstBinding.threadId);
          }
          fixture.native.threads.delete("original");
          const originalCut = await fork(source.sessionKey, users[1]!.entryId);
          expect(originalCut.ok).toBe(false);
          const later = await fork(source.sessionKey, users[3]!.entryId);
          expect(later, later.message).toMatchObject({ ok: true });
          const laterKey = expectDefined(later.key, "later descendant key");
          const laterBinding = expectDefined(
            fixture.bindingStore.read(fixture.identity(laterKey)),
            "later binding",
          );
          expect(fixture.native.threads.get(laterBinding.threadId)?.thread.turns).toEqual(
            currentBefore.thread.turns?.slice(0, 1),
          );
          expect(laterBinding.nativeHookRelayGeneration).not.toBe(
            firstBinding.nativeHookRelayGeneration,
          );
          expect(
            fixture.native.calls.filter(
              (call) =>
                call.method === "thread/inject_items" &&
                Array.isArray(call.params.items) &&
                call.params.items.some((item: { role?: string }) => item.role === "user"),
            ),
          ).toHaveLength(injections);
          await fixture.native.restart();
          expect(
            (
              await fixture.turn(laterKey, "descendant turn", {
                senderIsOwner: false,
                inspectTools: unavailable,
              })
            ).threadId,
          ).toBe(laterBinding.threadId);
          const childUsers = (await fixture.readEntries(laterKey)).filter(
            (entry) => entry.role === "user",
          );
          const again = await fork(laterKey, childUsers.at(-1)!.entryId);
          expect(again, again.message).toMatchObject({ ok: true });
          expect(
            fixture.native.calls.filter(
              (call) =>
                call.method === "thread/inject_items" &&
                Array.isArray(call.params.items) &&
                call.params.items.some((item: { role?: string }) => item.role === "user"),
            ),
          ).toHaveLength(injections);
          expect(current).toEqual(currentBefore);
          expect(fixture.native.source).toEqual(originalState);
        },
        {
          ...(loading === "direct" ? { loading } : {}),
          senderIsOwner: true,
          ...(runtime === "managed desktop"
            ? { desktopGenerationFingerprint: "synthetic-desktop-generation" }
            : {}),
          ...(appPolicy === "unconfigured"
            ? {}
            : {
                codexPlugins:
                  appPolicy === "empty"
                    ? {}
                    : appPolicy === "disabled"
                      ? { enabled: false }
                      : {
                          enabled: true,
                          allow_all_plugins: true,
                          allow_destructive_actions: false,
                        },
              }),
        },
      );
    },
    180_000,
  );

  it("keeps requester MCP declarations across fork and restart while reconnecting only the current caller", async () => {
    const sessions = new Set<string>();
    const calls: string[] = [];
    const resolutions: string[] = [];
    let initializations = 0;
    const handleRequest = async (request: http.IncomingMessage, response: http.ServerResponse) => {
      const sessionId = request.headers["mcp-session-id"];
      if (request.method === "DELETE") {
        if (typeof sessionId === "string") {
          sessions.delete(sessionId);
        }
        response.writeHead(204).end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      // SAFETY: this test server receives only JSON-RPC from its synthetic MCP client.
      const message = JSON.parse(body) as {
        id?: string | number;
        method: string;
        params?: { name?: string };
      };
      let result: unknown;
      if (message.method === "initialize") {
        const nextSessionId = `requester-session-${++initializations}`;
        sessions.add(nextSessionId);
        response.setHeader("mcp-session-id", nextSessionId);
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "canonical-requester-proof", version: "1.0.0" },
        };
      } else {
        if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
          response.writeHead(404).end();
          return;
        }
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "tools/list") {
          result = {
            tools: [
              {
                name: "probe",
                description: "Read the synthetic requester probe.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
          };
        } else if (message.method === "tools/call") {
          calls.push(message.params?.name ?? "missing");
          result = { content: [{ type: "text", text: "synthetic requester result" }] };
        } else {
          response.writeHead(400).end();
          return;
        }
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    const server = http.createServer((request, response) => {
      void handleRequest(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("requester MCP server did not bind a TCP port");
    }
    try {
      await withFixture(
        async (fixture, fork) => {
          const toolName = "requester-proof__probe";
          const runProbe = (key: string, expectedSpecs?: unknown) =>
            fixture.turn(key, "read requester probe", {
              senderId: "sender-a",
              senderIsOwner: true,
              inspectTools: async ({ bridge }) => {
                if (expectedSpecs) {
                  expect(bridge.specs).toEqual(expectedSpecs);
                }
                expect(bridge.availableTools.some((tool) => tool.name === toolName)).toBe(true);
                const binding = expectDefined(
                  fixture.bindingStore.read(fixture.identity(key)),
                  "requester turn binding",
                );
                const before = calls.length;
                const result = await bridge.handleToolCall({
                  threadId: binding.threadId,
                  turnId: "current",
                  callId: `requester-probe-${before}`,
                  namespace: null,
                  tool: toolName,
                  arguments: {},
                });
                expect(result, JSON.stringify(result.contentItems)).toMatchObject({
                  success: true,
                  executionStarted: true,
                });
                expect(JSON.stringify(result.contentItems)).toContain("synthetic requester result");
                expect(calls.slice(before)).toEqual(["probe"]);
              },
            });
          const source = await fixture.adopt();
          const sourceBinding = await runProbe(source.sessionKey);
          const inherited = structuredClone(
            expectDefined(fixture.native.threads.get(sourceBinding.threadId), "native source")
              .dynamicTools,
          );
          const beforeFork = {
            resolutions: resolutions.length,
            initializations,
            calls: calls.length,
          };
          const selected = expectDefined(
            (await fixture.readEntries(source.sessionKey)).at(-1),
            "cut",
          );
          const result = await fork(source.sessionKey, selected.entryId);
          expect(result, result.message).toMatchObject({ ok: true });
          expect({ resolutions: resolutions.length, initializations, calls: calls.length }).toEqual(
            beforeFork,
          );
          const childKey = expectDefined(result.key, "requester child key");
          const childBinding = expectDefined(
            fixture.bindingStore.read(fixture.identity(childKey)),
            "requester child binding",
          );
          expect(fixture.native.threads.get(childBinding.threadId)?.dynamicTools).toEqual(
            inherited,
          );
          const starts = fixture.native.calls.filter(
            (call) => call.method === "thread/start",
          ).length;
          const guest = await fixture.turn(childKey, "guest probe", {
            senderId: "guest",
            senderIsOwner: false,
            inspectTools: async ({ bridge }) => {
              expect(bridge.specs).toEqual(inherited);
              expect(bridge.availableTools.some((tool) => tool.name === toolName)).toBe(false);
              const before = calls.length;
              const denied = await bridge.handleToolCall({
                threadId: childBinding.threadId,
                turnId: "current",
                callId: "guest-probe",
                namespace: null,
                tool: toolName,
                arguments: {},
              });
              expect(denied).toMatchObject({ success: false, executionStarted: false });
              expect(calls).toHaveLength(before);
            },
          });
          expect(guest.threadId).toBe(childBinding.threadId);
          expect((await runProbe(childKey, inherited)).threadId).toBe(childBinding.threadId);
          const beforeRestart = initializations;
          for (const key of [source.sessionKey, childKey]) {
            await retireSessionMcpRuntime({
              sessionId: fixture.identity(key).sessionId,
              reason: "canonical requester restart",
            });
          }
          await fixture.native.restart();
          expect((await runProbe(source.sessionKey, inherited)).threadId).toBe(
            sourceBinding.threadId,
          );
          expect((await runProbe(childKey, inherited)).threadId).toBe(childBinding.threadId);
          expect(initializations).toBeGreaterThan(beforeRestart);
          expect(resolutions).toContain("guest");
          expect(
            resolutions.filter((sender) => sender === "sender-a").length,
          ).toBeGreaterThanOrEqual(4);
          expect(calls).toEqual(["probe", "probe", "probe", "probe"]);
          expect(
            fixture.native.calls.filter((call) => call.method === "thread/start"),
          ).toHaveLength(starts);
        },
        {
          mcpResolver: {
            serverName: "requester-proof",
            resolve: ({ requesterSenderId }) => {
              resolutions.push(requesterSenderId);
              return requesterSenderId === "sender-a"
                ? { url: `http://127.0.0.1:${address.port}/mcp` }
                : null;
            },
          },
        },
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 180_000);

  it("preserves stock original-source continuation and refuses ignored configuration on a loaded canonical thread", async () => {
    await withFixture(async (fixture, fork) => {
      const source = await fixture.adopt();
      const imported = await fixture.readEntries(source.sessionKey);
      const cut = await fork(source.sessionKey, imported.at(-1)!.entryId);
      expect(cut, cut.message).toMatchObject({ ok: true });
      const childKey = expectDefined(cut.key, "original child");
      const binding = await fixture.turn(childKey, "first original continuation");
      await fixture.turn(childKey, "second original continuation");
      expect(
        fixture.native.calls.filter((call) => call.method === "thread/inject_items"),
      ).toHaveLength(2);
      const before = fixture.bindingStore.read(fixture.identity(childKey));
      fixture.native.setCompetingSubscriber(true);
      const turnsBefore = fixture.native.calls.filter(
        (call) => call.method === "turn/start",
      ).length;
      await expect(fixture.turn(childKey, "configuration must apply")).rejects.toThrow(
        /confirm unloading/,
      );
      expect(fixture.bindingStore.read(fixture.identity(childKey))).toEqual(before);
      expect(fixture.native.calls.filter((call) => call.method === "turn/start")).toHaveLength(
        turnsBefore,
      );
      expect(fixture.native.threads.has(binding.threadId)).toBe(true);
    });
  }, 180_000);

  it.each([true, false])(
    "preserves recorded nondelivered rows and refuses unknown user provenance (blocked=%s)",
    async (blocked) => {
      await withFixture(async (fixture, fork) => {
        const source = await fixture.adopt();
        await fixture.turn(source.sessionKey, "first");
        const identity = fixture.identity(source.sessionKey);
        await appendSessionTranscriptMessagesByIdentity({
          config: fixture.config,
          storePath: fixture.storePath,
          agentId: "main",
          sessionId: identity.sessionId,
          sessionKey: source.sessionKey,
          messages: [
            {
              message: {
                role: "user",
                content: [{ type: "text", text: "local display only" }],
                ...(blocked
                  ? {
                      __openclaw: {
                        beforeAgentRunBlocked: {
                          blockedBy: "before_agent_run",
                          blockedAt: Date.now(),
                        },
                      },
                    }
                  : {}),
              },
            },
            {
              message: { role: "assistant", content: [{ type: "text", text: "Local commentary" }] },
            },
          ],
        });
        await fixture.turn(source.sessionKey, "selected");
        const entries = await fixture.readEntries(source.sessionKey);
        const before = fixture.native.calls.filter((call) => call.method === "thread/fork").length;
        const result = await fork(source.sessionKey, entries.at(-1)!.entryId);
        expect(result.ok, result.message).toBe(blocked);
        if (blocked) {
          const copied = await fixture.readEntries(expectDefined(result.key, "child"));
          expect(copied.map((entry) => entry.message)).toEqual(
            entries.slice(0, -1).map((entry) => entry.message),
          );
        } else {
          expect(fixture.native.calls.filter((call) => call.method === "thread/fork")).toHaveLength(
            before,
          );
        }
      });
    },
    180_000,
  );

  it("refuses a creator-required environment before native fork", async () => {
    await withFixture(async (fixture) => {
      const source = await fixture.adopt();
      await fixture.turn(source.sessionKey, "canonical");
      const entries = await fixture.readEntries(source.sessionKey);
      const before = fixture.native.calls.filter((call) => call.method === "thread/fork").length;
      const link = expectDefined(readSessionUpstreamLink(source.sessionKey, "main"), "root link");
      const harness = expectDefined(
        listRegisteredAgentHarnesses()[0]?.harness,
        "registered harness",
      );
      const result = await expectDefined(harness.sessionFork, "registered fork capability").fork({
        targetKey: "agent:main:dashboard:required-environment",
        sandbox: "required",
        source: {
          agentId: "main",
          sessionId: fixture.identity(source.sessionKey).sessionId,
          sessionKey: source.sessionKey,
          storePath: fixture.storePath,
          entryId: entries.at(-1)!.entryId,
        },
        upstream: {
          catalogId: link.catalogId,
          hostId: link.hostId,
          threadId: link.threadId,
          kind: link.upstreamKind,
          ref: link.upstreamRef,
        },
      });
      expect(result).toMatchObject({
        status: "failed",
        message: expect.stringMatching(/execution environment/),
      });
      expect(fixture.native.calls.filter((call) => call.method === "thread/fork")).toHaveLength(
        before,
      );
    });
  }, 180_000);

  it.each([
    ["ignored cut", /did not apply the exact beforeTurnId cut/],
    ["missing model", /model/i],
    ["null model", /model/i],
    ["model changed during preparation", /canonical Codex source changed/],
    ["provider changed during preparation", /canonical Codex source changed/],
    ["catalog mismatch", /native tool catalog is missing, corrupt, or changed/],
    ["child catalog", /did not preserve the actual native tool catalog/],
    ["child model", /did not preserve the exact canonical source and selected native model/],
    ["child thread model", /did not preserve the exact canonical source and selected native model/],
    [
      "null child thread model",
      /did not preserve the exact canonical source and selected native model/,
    ],
    ["child lineage", /unsafe native thread identity/],
    ["unsubscribe failure", /unsubscribe|subscription|guarded rollback/i],
  ])(
    "refuses %s without publishing an unsafe child",
    async (failure, expectedError) => {
      await withFixture(
        async (fixture, fork, _revoke, _admissions, runtime) => {
          const source = await fixture.adopt();
          const binding = await fixture.turn(source.sessionKey, "first canonical");
          const sourceBefore = structuredClone(fixture.native.source);
          const bindingBefore = fixture.bindingStore.read(fixture.identity(source.sessionKey));
          const existingSessions = new Set(
            listSessionEntriesCore({ agentId: "main", storePath: fixture.storePath }).map(
              ({ entry }) => entry.sessionId,
            ),
          );
          const messages = await fixture.readEntries(source.sessionKey);
          const countBefore = fixture.native.calls.filter(
            (call) => call.method === "thread/fork",
          ).length;
          const current = expectDefined(fixture.native.threads.get(binding.threadId), "canonical");
          const create = runtime.agent.session.createSessionEntry;
          const createSession = vi.spyOn(runtime.agent.session, "createSessionEntry");
          if (failure === "missing model") {
            delete current.thread.model;
          }
          if (failure === "null model") {
            current.thread.model = null;
          }
          if (
            failure === "model changed during preparation" ||
            failure === "provider changed during preparation"
          ) {
            createSession.mockImplementation((params) =>
              create({
                ...params,
                afterCreate: async (created) => {
                  if (failure === "model changed during preparation") {
                    current.thread.model = "gpt-5.5";
                  } else {
                    current.thread.modelProvider = "changed-provider";
                  }
                  const patch = await params.afterCreate?.(created);
                  if (!patch) {
                    throw new Error("Expected the canonical fork initialization patch");
                  }
                  return patch;
                },
              }),
            );
          }
          if (failure === "ignored cut") {
            fixture.native.setIgnoreCut(true);
          }
          if (failure === "catalog mismatch") {
            const thread = expectDefined(fixture.native.threads.get(binding.threadId), "canonical");
            thread.dynamicTools = [];
            await fixture.native.persist(thread);
          }
          if (failure === "child catalog") {
            fixture.native.setForkFault("catalog");
          }
          if (failure === "child model") {
            fixture.native.setForkFault("model");
          }
          if (failure === "child thread model") {
            fixture.native.setForkFault("thread-model");
          }
          if (failure === "null child thread model") {
            fixture.native.setForkFault("null-thread-model");
          }
          if (failure === "child lineage") {
            fixture.native.setForkFault("lineage");
          }
          if (failure === "unsubscribe failure") {
            fixture.native.setFailUnsubscribe(true);
          }
          const result = await fork(source.sessionKey, messages.at(-1)!.entryId);
          expect(result.ok, result.message).toBe(false);
          expect(result.message).toMatch(expectedError);
          if (failure === "missing model" || failure === "null model") {
            expect(createSession).not.toHaveBeenCalled();
          }
          expect(
            listSessionEntriesCore({ agentId: "main", storePath: fixture.storePath })
              .filter(({ entry }) => !existingSessions.has(entry.sessionId))
              .every(({ entry }) => entry.initializationPending === true),
            "failed forks must not publish a ready child",
          ).toBe(true);
          if (
            failure === "catalog mismatch" ||
            failure === "missing model" ||
            failure === "null model" ||
            failure === "model changed during preparation" ||
            failure === "provider changed during preparation"
          ) {
            expect(
              fixture.native.calls.filter((call) => call.method === "thread/fork"),
            ).toHaveLength(countBefore);
          }
          expect(fixture.native.source).toEqual(sourceBefore);
          expect(fixture.bindingStore.read(fixture.identity(source.sessionKey))).toEqual(
            bindingBefore,
          );
        },
        { senderIsOwner: true },
      );
    },
    180_000,
  );
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  prepareReplyToolAuthority,
  resolveFollowupRunToolAuthorityFingerprint,
} from "../../auto-reply/reply/reply-tool-authority.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveEmbeddedAgentSessionProgressState,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import { attachToolAllowlistIntersection } from "../tool-policy-shared.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import type { AgentQuestionDispatcher } from "./gateway-question-dispatch.js";
import {
  claimPendingAgentQuestionAnswer,
  claimPendingAgentQuestionAnswerFromCaller,
  registerPendingAgentQuestion,
  runAgentHarnessGatewayQuestion,
} from "./gateway-question.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

const sessionId = "authority-session";
const sessionKey = "agent:main:main";
const own: ReplyToolAuthorityOverlay = {
  senderIsOwner: true,
  disableTools: false,
  traceAuthorized: false,
  messageProvider: "webchat",
};
const attempt = {
  sessionId,
  sessionKey,
  runId: "authority-run",
  agentId: "main",
  config: {},
  sessionFile: "/tmp/authority-session.jsonl",
  workspaceDir: "/tmp/authority-workspace",
  provider: "openai",
  modelId: "gpt-test",
  sandboxSessionKey: sessionKey,
  senderIsOwner: true,
  messageProvider: "webchat",
  traceAuthorized: false,
};

async function admitted<T>(
  run: (context: {
    admittedRunContext: Awaited<ReturnType<ReturnType<typeof prepareAgentRunAdmission>["admit"]>>;
    close: () => void;
  }) => Promise<T>,
) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
    facts: {
      agentId: "main",
      runId: attempt.runId,
      ingress: { kind: "system", state: "present", boundary: "tool-authority-test" },
    },
  });
  try {
    return await run({
      admittedRunContext: await admission.admit("embedded", "authority-test"),
      close: admission.close,
    });
  } finally {
    admission.close();
  }
}

function publishPreparedHandle(
  toolAuthorityFingerprint: string | undefined,
  queueMessage: ReturnType<typeof createEmbeddedRunHandle>["queueMessage"],
) {
  const handle = createEmbeddedRunHandle({
    runId: attempt.runId,
    toolAuthorityFingerprint,
    queueMessage,
  });
  setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
  return handle;
}

async function published<T>(
  run: (owner: {
    handle: ReturnType<typeof createEmbeddedRunHandle>;
    queue: ReturnType<typeof vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>>;
  }) => Promise<T>,
  params: Partial<typeof attempt> & { toolsAllow?: string[] } = {},
) {
  return admitted(async ({ admittedRunContext }) =>
    withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext },
      { ...attempt, ...params },
      undefined,
      async (prepared) => {
        const queue = vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>(
          async () => {},
        );
        const handle = publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
        try {
          return await run({ handle, queue });
        } finally {
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        }
      },
    ),
  );
}

function steer(overlay: ReplyToolAuthorityOverlay, hash?: string) {
  return queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "Use the release branch", {
    isInboundUserMessage: true,
    toolAuthorityOverlay: overlay,
    toolAuthorityFingerprint: hash,
    taskSuggestionDeliveryMode: undefined,
  });
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

describe("host-prepared embedded tool authority", () => {
  it("captures only a matching admitted owner for legacy active-run registration", async () => {
    const params = {
      ...attempt,
      agentId: "ops",
      sessionKey: "global",
      sandboxSessionKey: "global",
    };
    const handle = createEmbeddedRunHandle({ runId: params.runId });
    const state = (agentId: string) =>
      resolveEmbeddedAgentSessionProgressState(params.sessionId, {
        agentId,
        defaultAgentId: "main",
      });
    const admission = prepareAgentRunAdmission({
      cfg: { agents: { list: [{ id: "main", default: true }, { id: "ops" }] } },
      operationalRunInstance: createOperationalRunInstanceRef(params.runId),
      facts: {
        agentId: params.agentId,
        runId: params.runId,
        ingress: { kind: "system", state: "present", boundary: "tool-authority-test" },
      },
    });
    try {
      await withGatewayToolCallerIdentity({ agentId: "ops", sessionKey: "global" }, () => {
        setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
        expect(state("ops")).toBeUndefined();
      });
      clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
      const admittedRunContext = await admission.admit("embedded", "authority-test");
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        params,
        undefined,
        async (prepared) => {
          handle.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
          setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, params.sessionFile);
          expect(state("ops")).toBe("running");
          expect(state("main")).toBeUndefined();
        },
      );
      expect(state("ops")).toBe("running");
      expect(state("main")).toBeUndefined();
    } finally {
      clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
      admission.close();
    }
  });

  it.each(["claim", "wrapper", "lifecycle", "persistence"] as const)(
    "refuses early native-question answers after creator %s closure",
    async (closure) => {
      await admitted(async ({ admittedRunContext, close }) => {
        const gatewayCall = vi.fn(async () => ({ status: "answered" }));
        let question: ReturnType<typeof registerPendingAgentQuestion> | undefined;
        const answer = () =>
          claimPendingAgentQuestionAnswer({
            sessionKey,
            text: "Continue",
            persist: async () => {
              if (closure === "persistence") {
                close();
              }
            },
          });
        try {
          await withPreparedEmbeddedRunToolAuthority(
            { admittedRunContext },
            attempt,
            undefined,
            async () => {
              // Native callbacks can ask before publishing an embedded queue handle.
              question = registerPendingAgentQuestion({
                questionId: "early-native-question",
                sessionKey,
                questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
                gatewayCall,
                answer: Promise.resolve({ status: "pending" }),
              });
              question.attachRegistration(Promise.resolve({ id: "early-native-question" }));
              if (closure === "wrapper") {
                return;
              }
              if (closure === "claim") {
                close();
              } else if (closure === "lifecycle") {
                rotateAgentEventLifecycleGeneration();
              }
              await expect(answer()).rejects.toThrow("no longer active");
            },
          );
          if (closure === "wrapper") {
            await expect(answer()).rejects.toThrow("no longer active");
          }
          expect(gatewayCall).not.toHaveBeenCalled();
        } finally {
          question?.dispose();
        }
      });
    },
  );

  it("checks early question caller policy without a published handle", async () => {
    await admitted(async ({ admittedRunContext }) =>
      withPreparedEmbeddedRunToolAuthority({ admittedRunContext }, attempt, undefined, async () => {
        const dispatch = vi.fn<AgentQuestionDispatcher["call"]>(async ({ authority }) => {
          if (authority.kind === "source-bound") {
            authority.assertCurrent();
          }
          return { status: "answered" };
        });
        const question = registerPendingAgentQuestion({
          questionId: "early-caller-policy",
          sessionKey,
          questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
          gatewayCall: { version: 2, call: dispatch },
          answer: Promise.resolve({ status: "pending" }),
        });
        question.attachRegistration(Promise.resolve({ id: "early-caller-policy" }));
        const source = vi.fn();
        const answer = (caller: ReplyToolAuthorityOverlay) =>
          claimPendingAgentQuestionAnswerFromCaller({
            sessionKey,
            text: "Continue",
            caller,
            assertSourceCurrent: source,
          });
        try {
          await expect(answer({ ...own, toolsAllow: [] })).rejects.toThrow("caller policy");
          await expect(answer({ ...own, permissionMode: "guarded" })).rejects.toThrow(
            "caller policy",
          );
          expect(dispatch).not.toHaveBeenCalled();
          await expect(answer(own)).resolves.toBe(true);
          expect(dispatch).toHaveBeenCalledOnce();
          expect(source).toHaveBeenCalled();
        } finally {
          question.dispose();
        }
      }),
    );
  });

  it("does not upgrade a legacy unbound question through the caller-gated entry", async () => {
    const gatewayCall = vi.fn(async () => ({ status: "answered" }));
    const question = registerPendingAgentQuestion({
      questionId: "legacy-unbound-question",
      sessionKey,
      questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
      gatewayCall,
      answer: Promise.resolve({ status: "pending" }),
    });
    question.attachRegistration(Promise.resolve({ id: "legacy-unbound-question" }));
    try {
      await expect(
        claimPendingAgentQuestionAnswerFromCaller({
          sessionKey,
          text: "Continue",
          caller: own,
          assertSourceCurrent: () => {},
        }),
      ).rejects.toThrow("no prepared creator authority");
      expect(gatewayCall).not.toHaveBeenCalled();
      await expect(claimPendingAgentQuestionAnswer({ sessionKey, text: "Continue" })).resolves.toBe(
        true,
      );
    } finally {
      question.dispose();
    }
  });

  it("keeps secret input behind the same creator caller policy", async () => {
    await admitted(async ({ admittedRunContext }) =>
      withPreparedEmbeddedRunToolAuthority({ admittedRunContext }, attempt, undefined, async () => {
        const controller = new AbortController();
        const pending = runAgentHarnessGatewayQuestion({
          sessionKey,
          timeoutMs: 1_000,
          delivery: {},
          signal: controller.signal,
          questions: [
            { id: "choice", header: "Choice", question: "Secret input?", isSecret: true },
          ],
        });
        try {
          await expect(
            claimPendingAgentQuestionAnswerFromCaller({
              sessionKey,
              text: "synthetic-input",
              caller: { ...own, toolsAllow: [] },
              assertSourceCurrent: () => {},
            }),
          ).rejects.toThrow("caller policy");
          await expect(
            claimPendingAgentQuestionAnswerFromCaller({
              sessionKey,
              text: "synthetic-input",
              caller: own,
              assertSourceCurrent: () => {},
            }),
          ).resolves.toBe(true);
          await expect(pending).resolves.toMatchObject({ status: "answered" });
        } finally {
          controller.abort();
          await pending;
        }
      }),
    );
  });

  it("requires voice caller evidence without audit identity and strips host evidence", async () => {
    await published(async ({ handle, queue }) => {
      expect(getGatewayToolCallerIdentity()?.executionIdentityToken).toBeUndefined();
      expect(handle.toolAuthorityFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const input = { sessionKey, text: "Use the release branch" };
      await expect(controlRealtimeVoiceAgentRun(input)).resolves.toMatchObject({
        ok: false,
        active: true,
        queued: false,
        reason: "tool_authority_mismatch",
        speak: true,
      });
      expect(queue).not.toHaveBeenCalled();
      await expect(
        controlRealtimeVoiceAgentRun({ ...input, getToolAuthorityOverlay: () => own }),
      ).resolves.toMatchObject({ ok: true, queued: true });
      expect(queue).toHaveBeenCalledOnce();
      expect(queue.mock.calls[0]?.[1]).not.toHaveProperty("toolAuthorityOverlay");
      expect(queue.mock.calls[0]?.[1]).toHaveProperty("taskSuggestionDeliveryMode", undefined);
    });
  });

  it.each([
    { permissionMode: "guarded" as const },
    { toolOverrides: { webSearch: false } },
    { clientCaps: ["task_suggestions"] },
    { toolsAllow: [] },
    { traceAuthorized: true },
  ])("rejects changed caller facts even with a copied target hash: %j", async (changed) => {
    await published(async ({ handle, queue }) => {
      await expect(
        steer({ ...own, ...changed }, handle.toolAuthorityFingerprint),
      ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
      expect(queue).not.toHaveBeenCalled();
    });
  });

  it("uses concrete modelId and sandbox key, not the descriptor or execution key", async () => {
    await admitted(async ({ admittedRunContext }) => {
      const direct = {
        ...attempt,
        model: { id: "descriptor-only" },
        sandboxSessionKey: "agent:main:voice",
        config: { agents: { defaults: { sandbox: { mode: "non-main" as const } } } },
      };
      const expected = resolveFollowupRunToolAuthorityFingerprint({
        run: {
          ...attempt,
          config: direct.config,
          model: attempt.modelId,
          runtimePolicySessionKey: direct.sandboxSessionKey,
        },
      });
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        direct,
        undefined,
        async (prepared) => {
          expect(prepared.toolAuthorityFingerprint).toBe(expected);
          expect(prepared.toolAuthorityFingerprint).not.toBe(
            resolveFollowupRunToolAuthorityFingerprint({
              run: {
                ...attempt,
                config: direct.config,
                model: attempt.modelId,
                runtimePolicySessionKey: sessionKey,
              },
            }),
          );
        },
      );
    });
  });

  it("rejects a weaker current sender under the real configured policy", async () => {
    await published(
      async ({ handle, queue }) => {
        await expect(
          steer({ ...own, senderIsOwner: false }, handle.toolAuthorityFingerprint),
        ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
        expect(queue).not.toHaveBeenCalled();
      },
      { config: { tools: { toolsBySender: { "*": { allow: [] } } } } },
    );
  });

  it("does not treat a publisher's changed hash as new authority", async () => {
    await published(async ({ handle, queue }) => {
      handle.toolAuthorityFingerprint = resolveFollowupRunToolAuthorityFingerprint({
        toolsAllow: [],
        run: {
          ...attempt,
          model: attempt.modelId,
          runtimePolicySessionKey: attempt.sandboxSessionKey,
        },
      });
      await expect(
        steer({ ...own, toolsAllow: [] }, handle.toolAuthorityFingerprint),
      ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
      expect(queue).not.toHaveBeenCalled();
    });
  });

  it("rejects an unbound handle even when the caller copies its genuine baseline", async () => {
    await published(async ({ handle, queue }) => {
      withoutGatewayToolCallerIdentity(() =>
        setActiveEmbeddedRun(sessionId, { ...handle }, sessionKey),
      );
      await expect(steer(own, handle.toolAuthorityFingerprint)).resolves.toMatchObject({
        queued: false,
        reason: "tool_authority_mismatch",
      });
      expect(queue).not.toHaveBeenCalled();
    });
  });

  it.each(["false", "throw"])(
    "revalidates source authority after policy projection (%s)",
    async (failure) => {
      await admitted(async ({ admittedRunContext }) => {
        let live = true;
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            operationalRunInstance: admittedRunContext.operationalRunInstance,
            receiptAuthority: () => {
              if (!live && failure === "throw") {
                throw new Error("closed source");
              }
              return live;
            },
          },
          () =>
            withPreparedEmbeddedRunToolAuthority(
              { admittedRunContext },
              attempt,
              undefined,
              async (prepared) => {
                const queue = vi.fn(async () => {});
                publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
                await expect(
                  steer({
                    ...own,
                    get permissionMode() {
                      live = false;
                      return undefined;
                    },
                  }),
                ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
                expect(queue).not.toHaveBeenCalled();
              },
            ),
        );
      });
    },
  );

  it("preserves hidden allowlist intersections and freezes the prepared policy", async () => {
    const toolsAllow = attachToolAllowlistIntersection(["exec"], [["exec"]]);
    await published(
      async ({ queue }) => {
        toolsAllow.push("message");
        await expect(
          steer({ ...own, toolsAllow: attachToolAllowlistIntersection(["exec"], [["exec"]]) }),
        ).resolves.toMatchObject({ queued: true });
        await expect(
          steer({
            ...own,
            toolsAllow: attachToolAllowlistIntersection(["exec"], [["exec"], ["message"]]),
          }),
        ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
        expect(queue).toHaveBeenCalledOnce();
      },
      { toolsAllow },
    );
  });

  it.each(["claim", "wrapper", "lifecycle"])(
    "rejects retained projection after %s closure",
    async (reason) => {
      await admitted(async ({ admittedRunContext, close }) => {
        const queue = vi.fn(async () => {});
        let retained: ReturnType<typeof getGatewayToolCallerIdentity>;
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          attempt,
          undefined,
          async (prepared) => {
            retained = getGatewayToolCallerIdentity();
            publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
            if (reason === "claim") {
              close();
            }
            if (reason === "lifecycle") {
              rotateAgentEventLifecycleGeneration();
            }
            if (reason !== "wrapper") {
              expect((await steer(own)).queued).toBe(false);
            }
          },
        );
        expect((await steer(own)).queued).toBe(false);
        await expect(
          withGatewayToolCallerIdentity(retained, () =>
            setActiveEmbeddedRun(
              sessionId,
              createEmbeddedRunHandle({ runId: attempt.runId }),
              sessionKey,
              attempt.sessionFile,
            ),
          ),
        ).rejects.toThrow("no longer active");
        expect(queue).not.toHaveBeenCalled();
      });
    },
  );

  it("does not inherit a registration binding into a distinct admitted instance", async () => {
    await admitted(async ({ admittedRunContext }) =>
      withPreparedEmbeddedRunToolAuthority({ admittedRunContext }, attempt, undefined, async () => {
        const current = getGatewayToolCallerIdentity();
        expect(current?.embeddedRunToolAuthorityBinding).toBeTypeOf("function");
        await withGatewayToolCallerIdentity({ agentId: "main", sessionKey }, () => {
          expect(getGatewayToolCallerIdentity()?.embeddedRunToolAuthorityBinding).toBe(
            current?.embeddedRunToolAuthorityBinding,
          );
        });
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            operationalRunInstance: { ...admittedRunContext.operationalRunInstance },
          },
          () => {
            expect(getGatewayToolCallerIdentity()?.embeddedRunToolAuthorityBinding).toBeUndefined();
          },
        );
      }),
    );
  });

  it("rejects replacement during projection without delivering to either handle", async () => {
    await published(async ({ queue }) => {
      const successorQueue = vi.fn(async () => {});
      const overlay = {
        ...own,
        get permissionMode() {
          // Model-policy preparation can invoke host getters; capture must not retarget.
          withoutGatewayToolCallerIdentity(() =>
            setActiveEmbeddedRun(
              sessionId,
              createEmbeddedRunHandle({ runId: "successor", queueMessage: successorQueue }),
              sessionKey,
            ),
          );
          return undefined;
        },
      };
      expect((await steer(overlay)).queued).toBe(false);
      expect(queue).not.toHaveBeenCalled();
      expect(successorQueue).not.toHaveBeenCalled();
    });
  });

  it("publishes maintenance authority without borrowing a lifecycle-only reply snapshot", async () => {
    await admitted(async ({ admittedRunContext }) => {
      const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
      const parent = createQueueTestRun({ prompt: "parent reply" });
      parent.run.traceAuthorized = true;
      operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(parent));
      try {
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          { ...attempt, toolsAllow: [] },
          undefined,
          async (prepared) => {
            const queue = vi.fn(async () => {});
            publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
            await expect(steer(own)).resolves.toMatchObject({
              queued: false,
              reason: "tool_authority_mismatch",
            });
            await expect(steer({ ...own, toolsAllow: [] })).resolves.toMatchObject({
              queued: true,
            });
            expect(queue).toHaveBeenCalledOnce();
          },
        );
      } finally {
        operation.complete();
      }
    });
  });

  it.each(["candidate", "prepared-model", "unprepared"])(
    "keeps a normal reply's richer snapshot when the route is chosen at %s",
    async (selectionPhase) => {
      await admitted(async ({ admittedRunContext }) => {
        const original = createQueueTestRun({ prompt: "normal reply" });
        original.run.traceAuthorized = true;
        original.run.clientCaps = ["normal-client"];
        original.run.approvalReviewerDeviceId = "review-device";
        const route = { provider: "anthropic", model: "fallback-test" };
        const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
        const snapshot = prepareReplyToolAuthority(original);
        let failProjection = false;
        operation.bindToolAuthoritySnapshot({
          ...snapshot,
          project: (overlay, selectedRoute) => {
            if (failProjection) {
              throw new Error("projection failed");
            }
            return snapshot.project(overlay, selectedRoute);
          },
        });
        const initialRoute =
          selectionPhase === "candidate"
            ? route
            : { provider: original.run.provider, model: original.run.model };
        if (selectionPhase !== "unprepared") {
          operation.bindToolAuthorityRoute(initialRoute);
        }
        const initialFingerprint = snapshot.fingerprint(initialRoute);
        const fingerprint = snapshot.fingerprint(route);
        await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operation },
          {
            ...attempt,
            provider: route.provider,
            modelId: route.model,
            toolAuthorityFingerprint: initialFingerprint,
          },
          undefined,
          async (prepared) => {
            const queue = vi.fn(async () => {});
            const handle = {
              ...createEmbeddedRunHandle({
                runId: attempt.runId,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                queueMessage: queue,
              }),
              kind: "embedded" as const,
              cancel: () => {},
            };
            setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
            operation.attachBackend(handle);
            operation.setPhase("running");
            const incoming = {
              senderIsOwner: false,
              disableTools: false,
              traceAuthorized: true,
              clientCaps: ["normal-client"],
              approvalReviewerDeviceId: "review-device",
            };
            await expect(steer(incoming)).resolves.toMatchObject({ queued: true });
            expect(prepared.toolAuthorityFingerprint).toBe(fingerprint);
            await expect(
              steer({
                ...incoming,
                get permissionMode() {
                  operation.attachBackend({ ...handle });
                  return undefined;
                },
              }),
            ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
            operation.attachBackend(handle);
            failProjection = true;
            await expect(steer(incoming, fingerprint)).resolves.toMatchObject({
              queued: false,
              reason: "tool_authority_mismatch",
            });
            failProjection = false;
            operation.bindToolAuthorityRoute({ provider: "openai", model: "replacement-route" });
            await expect(steer(incoming, fingerprint)).resolves.toMatchObject({
              queued: false,
              reason: "tool_authority_mismatch",
            });
            operation.bindToolAuthorityRoute(route);
            operation.attachBackend({ ...handle });
            // A different attached backend cannot confer authority on the published handle.
            await expect(steer(incoming)).resolves.toMatchObject({
              queued: false,
              reason: "tool_authority_mismatch",
            });
            expect(queue).toHaveBeenCalledOnce();
          },
        );
        operation.complete();
      });
    },
  );
});

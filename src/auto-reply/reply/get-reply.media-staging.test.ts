import { beforeAll, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForAbortSignal } from "../../infra/abort-signal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withFastReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyGroupCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyBaselineBypass,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import { createReplySessionEntryHandle } from "./session-entry-handle.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  initSessionState: vi.fn(),
  resolveReplySessionPreprocessingState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
  handleInlineActions: vi.fn(),
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));

registerGetReplyBaselineBypass();
registerGetReplyRuntimeOverrides(mocks);
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: mocks.createInternalHookEvent,
  triggerInternalHook: mocks.triggerInternalHook,
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let stageSandboxMedia: typeof import("./stage-sandbox-media.runtime.js").stageSandboxMedia;
let applyMediaUnderstanding: typeof import("../../media-understanding/apply.runtime.js").applyMediaUnderstanding;
let runPreparedReply: typeof import("./get-reply-run.js").runPreparedReply;

beforeAll(async () => {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ stageSandboxMedia } = await import("./stage-sandbox-media.runtime.js"));
  ({ applyMediaUnderstanding } = await import("../../media-understanding/apply.runtime.js"));
  ({ runPreparedReply } = await import("./get-reply-run.js"));
  const { resolveDefaultModel } = await import("./directive-handling.defaults.js");
  vi.mocked(resolveDefaultModel).mockReturnValue({
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
  });
});

it.each(["remote preprocessing", "local staging"] as const)(
  "cancels %s before downstream work and waits for staging cleanup",
  async (phase) => {
    await withOpenClawTestState(
      { label: "reply-media-staging", env: { OPENCLAW_TEST_FAST: undefined } },
      async (state) => {
        const controller = new AbortController();
        const reason = new Error("attachment request cancelled");
        const cleanup = createDeferred();
        let cleanupStarted = false;
        let cleanupFinished = false;
        vi.mocked(stageSandboxMedia)
          .mockReset()
          .mockImplementationOnce(
            async (
              params: Parameters<typeof stageSandboxMedia>[0] & { abortSignal?: AbortSignal },
            ) => {
              try {
                await waitForAbortSignal(params.abortSignal);
                params.abortSignal?.throwIfAborted();
                return { staged: new Map<number, string>() };
              } finally {
                cleanupStarted = true;
                await cleanup.promise;
                cleanupFinished = true;
              }
            },
          );
        vi.mocked(applyMediaUnderstanding).mockReset().mockResolvedValue({
          outputs: [],
          decisions: [],
          extractedFileImages: [],
          appliedImage: false,
          appliedAudio: false,
          appliedVideo: false,
          appliedFile: false,
        });
        vi.mocked(runPreparedReply).mockReset().mockResolvedValue({ text: "must not reply" });
        mocks.createInternalHookEvent.mockClear();
        mocks.triggerInternalHook.mockClear();
        const ctx = buildGetReplyGroupCtx({
          media: [{ path: "/remote/photo.jpg", contentType: "image/jpeg" }],
          MediaRemoteHost: phase === "remote preprocessing" ? "user@gateway-host" : undefined,
        });
        mocks.initSessionState.mockReset().mockResolvedValue(
          createGetReplySessionState({
            sessionCtx: ctx,
            storePath: state.path("sessions.json"),
            sessionEntryHandle: createReplySessionEntryHandle({}),
          }),
        );
        mocks.resolveReplySessionPreprocessingState.mockReset().mockReturnValue({
          sessionEntry: undefined,
          sessionKey: ctx.SessionKey,
          storePath: state.path("sessions.json"),
        });
        mocks.resolveReplyDirectives.mockReset().mockResolvedValue(
          createGetReplyContinueDirectivesResult({
            body: "inspect this attachment",
            abortKey: "agent:main:telegram:-100123",
            from: "telegram:user:42",
            to: "telegram:-100123",
            senderId: "42",
            commandSource: "message",
            senderIsOwner: false,
            resetHookTriggered: false,
          }),
        );
        mocks.handleInlineActions.mockReset().mockResolvedValue({
          kind: "continue",
          directives: {},
          cleanedBody: "inspect this attachment",
        });
        const reply = getReplyFromConfig(
          ctx,
          { abortSignal: controller.signal },
          withFastReplyConfig({ agents: { defaults: { workspace: state.workspaceDir } } }),
        );
        const replySettlement = vi.fn();
        const joined = reply.then(replySettlement, replySettlement);
        try {
          await vi.waitFor(() => expect(stageSandboxMedia).toHaveBeenCalledOnce());
          const preprocessingCalls = phase === "remote preprocessing" ? 0 : 1;
          expect(applyMediaUnderstanding).toHaveBeenCalledTimes(preprocessingCalls);
          expect(mocks.triggerInternalHook).toHaveBeenCalledTimes(preprocessingCalls);
          controller.abort(reason);
          await vi.waitFor(() => expect(cleanupStarted).toBe(true));
          expect(cleanupFinished).toBe(false);
          expect(replySettlement).not.toHaveBeenCalled();
          expect(runPreparedReply).not.toHaveBeenCalled();

          cleanup.resolve();
          await expect.soft(reply).rejects.toBe(reason);
          expect(cleanupFinished).toBe(true);
          expect.soft(applyMediaUnderstanding).toHaveBeenCalledTimes(preprocessingCalls);
          expect.soft(mocks.triggerInternalHook).toHaveBeenCalledTimes(preprocessingCalls);
          expect.soft(mocks.createInternalHookEvent).toHaveBeenCalledTimes(preprocessingCalls);
          expect.soft(runPreparedReply).not.toHaveBeenCalled();
          if (phase === "remote preprocessing") {
            expect.soft(mocks.initSessionState).not.toHaveBeenCalled();
            expect.soft(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
            expect.soft(mocks.handleInlineActions).not.toHaveBeenCalled();
          }
        } finally {
          controller.abort(reason);
          cleanup.resolve();
          await joined;
        }
      },
    );
  },
);

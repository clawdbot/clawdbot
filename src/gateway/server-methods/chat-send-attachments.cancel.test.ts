import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import * as sandboxWorkspace from "../../agents/sandbox/context.js";
import * as staging from "../../auto-reply/reply/stage-sandbox-media.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById } from "../chat-abort.js";
import * as attachments from "../chat-attachments.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";
import type { RespondFn } from "./types.js";

it.each([
  {
    name: "returns signal-only cancellation after TXT cleanup",
    pdf: false,
    interruption: "signal",
    stageError: "abort",
    outcome: "aborted",
  },
  {
    name: "does not turn managed-PDF cancellation into a host-path fallback",
    pdf: true,
    interruption: "signal",
    stageError: "abort",
    outcome: "aborted",
  },
  {
    name: "retains an ordinary TXT failure when the signal is also aborted",
    pdf: false,
    interruption: "signal",
    stageError: "ordinary",
    outcome: "unavailable",
  },
  {
    name: "retains explicit RPC abort precedence over a later TXT failure",
    pdf: false,
    interruption: "marker",
    stageError: "ordinary",
    outcome: "aborted",
  },
  {
    name: "retains the managed-PDF host-path fallback for an ordinary failure",
    pdf: true,
    interruption: "none",
    stageError: "ordinary",
    outcome: "fallback",
  },
  {
    name: "cancels successful unsandboxed preparation only after inbound cleanup",
    pdf: false,
    interruption: "signal",
    stageError: "abort",
    outcome: "aborted",
    preparation: "sandbox-null",
  },
  {
    name: "cancels managed-PDF pass-through only after inbound cleanup",
    pdf: true,
    interruption: "signal",
    stageError: "abort",
    outcome: "aborted",
    preparation: "pass-through",
  },
  {
    name: "retains ordinary TXT failure when RPC abort arrives during cleanup",
    pdf: false,
    interruption: "late-marker",
    stageError: "ordinary",
    outcome: "unavailable",
  },
] as const)("$name", async (testCase) => {
  const { pdf, interruption, stageError, outcome } = testCase;
  const preparation = "preparation" in testCase ? testCase.preparation : "stage";
  await withOpenClawTestState({ label: "gateway-attachment-cancellation" }, async (state) => {
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: { workspace: state.workspaceDir } },
        defaults: {
          skipBootstrap: true,
          ...(preparation === "pass-through" ? { mediaMaxMb: 51 } : {}),
          sandbox: {
            mode: preparation === "sandbox-null" ? "off" : "all",
            scope: "agent",
            workspaceRoot: state.path("sandboxes"),
            workspaceAccess: "none",
          },
        },
      },
    } satisfies OpenClawConfig;
    await state.writeConfig(cfg);
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    const runId = "attachment-cancellation";
    const bytes =
      preparation === "pass-through"
        ? Buffer.alloc(staging.SANDBOX_MEDIA_MAX_BYTES + 1, " ")
        : Buffer.from(pdf ? "%PDF-1.4\n% synthetic attachment\n%%EOF\n" : "synthetic attachment");
    if (preparation === "pass-through") {
      bytes.write("%PDF-1.4\n% synthetic attachment\n");
      bytes.write("%%EOF\n", bytes.length - 6);
    }
    let inboundPath: string | undefined;
    const filesPresentAtResponse: boolean[] = [];
    const respond = vi.fn<RespondFn>(() => {
      filesPresentAtResponse.push(inboundPath !== undefined && existsSync(inboundPath));
    });
    const setup = await prepareAndAdmitChatSend({
      client: null,
      context,
      respond,
      params: {
        agentId: "main",
        sessionKey: "agent:main:main",
        message: "read the attached file",
        idempotencyKey: runId,
        attachments: [
          {
            fileName: pdf ? "notes.pdf" : "notes.txt",
            mimeType: pdf ? "application/pdf" : "text/plain",
            content: bytes.toString("base64"),
          },
        ],
      },
    });
    expect(respond).not.toHaveBeenCalled();
    if (!setup) {
      throw new Error("chat admission failed before attachment preparation");
    }
    const admission = setup.admitted.value;
    const signal = admission.activeRunAbort.controller.signal;
    const ordinaryFailure = new Error("synthetic staging filesystem failure");
    const stageRelease = createDeferred();
    const cleanupRelease = createDeferred();
    const discard = attachments.discardPreparedInboundMedia;
    const parse = attachments.parseMessageWithAttachments;
    const ensureSandbox = sandboxWorkspace.ensureSandboxWorkspaceForSession;
    const preparationEntered = createDeferred();
    const parseSpy = vi
      .spyOn(attachments, "parseMessageWithAttachments")
      .mockImplementation(async (...args) => {
        const result = await parse(...args);
        inboundPath = result.offloadedRefs[0]?.path;
        if (preparation === "pass-through") {
          preparationEntered.resolve();
          await stageRelease.promise;
        }
        return result;
      });
    const sandboxSpy =
      preparation === "sandbox-null"
        ? vi
            .spyOn(sandboxWorkspace, "ensureSandboxWorkspaceForSession")
            .mockImplementation(async (...args) => {
              const result = await ensureSandbox(...args);
              if (result !== null) {
                throw new Error("the unsandboxed fixture unexpectedly provisioned a workspace");
              }
              preparationEntered.resolve();
              await stageRelease.promise;
              return result;
            })
        : undefined;
    const failureSpy = vi.spyOn(attachments, "logAttachmentFailure");
    const discardSpy = vi
      .spyOn(attachments, "discardPreparedInboundMedia")
      .mockImplementation(async (...args) => {
        await cleanupRelease.promise;
        await discard(...args);
      });
    const stageSpy = vi.spyOn(staging, "stageSandboxMedia").mockImplementation(async ({ ctx }) => {
      inboundPath = ctx.media?.[0]?.path;
      preparationEntered.resolve();
      await stageRelease.promise;
      throw stageError === "abort" ? signal.reason : ordinaryFailure;
    });
    let prepared: Awaited<ReturnType<typeof prepareChatSendAttachments>> | undefined;
    const preparing = prepareChatSendAttachments({
      request: setup.normalizedRequest.value,
      session: setup.preparedSession.value,
      admission,
      respond,
      context,
    }).then((result) => {
      prepared = result;
      return result;
    });

    try {
      await Promise.race([
        preparationEntered.promise,
        preparing.then(() => {
          throw new Error("attachment preparation completed before reaching the held boundary");
        }),
      ]);
      if (preparation === "stage") {
        expect(stageSpy).toHaveBeenCalledOnce();
      } else {
        expect(stageSpy).not.toHaveBeenCalled();
      }
      if (!inboundPath) {
        throw new Error("the real attachment parser did not create an inbound file");
      }
      expect((await fs.readFile(inboundPath)).equals(bytes)).toBe(true);
      if (interruption === "marker") {
        expect(
          abortChatRunById(createChatAbortOps(context), {
            runId,
            sessionKey: setup.preparedSession.value.sessionKey,
            stopReason: "rpc",
          }),
        ).toEqual({ aborted: true });
      } else if (interruption === "signal") {
        admission.activeRunAbort.controller.abort(createAgentRunDirectAbortError());
      }
      expect(signal.aborted).toBe(interruption === "signal" || interruption === "marker");
      expect(context.chatRunState.hasAbortMarker(runId)).toBe(interruption === "marker");
      stageRelease.resolve();

      if (outcome === "fallback") {
        const result = await preparing;
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("ordinary managed-PDF fallback failed");
        }
        expect(result.value.mediaPathOffloadPaths).toEqual([inboundPath]);
        expect((await fs.readFile(inboundPath)).equals(bytes)).toBe(true);
        expect(discardSpy).not.toHaveBeenCalled();
        expect(respond).not.toHaveBeenCalled();
        return;
      }

      // Cancellation must retain admission until the real abandoned-file
      // cleanup settles; neither a PDF fallback nor an early response owns it.
      await vi.waitFor(() => expect(discardSpy).toHaveBeenCalledOnce());
      expect(prepared).toBeUndefined();
      expect(admission.gatewayWorkAdmission.isActive()).toBe(true);
      expect(respond).not.toHaveBeenCalled();
      expect(existsSync(inboundPath)).toBe(true);
      if (interruption === "late-marker") {
        expect
          .soft(
            abortChatRunById(createChatAbortOps(context), {
              runId,
              sessionKey: setup.preparedSession.value.sessionKey,
              stopReason: "rpc",
            }),
          )
          .toEqual({ aborted: false });
        expect.soft(signal.aborted).toBe(false);
        expect.soft(context.chatRunState.hasAbortMarker(runId)).toBe(false);
        expect(admission.gatewayWorkAdmission.isActive()).toBe(true);
      }
      cleanupRelease.resolve();
      expect(await preparing).toEqual({ ok: false });
      expect(admission.gatewayWorkAdmission.isActive()).toBe(false);
      expect(filesPresentAtResponse).toEqual([false]);
      expect(respond).toHaveBeenCalledOnce();
      if (interruption === "late-marker") {
        expect
          .soft(vi.mocked(context.broadcast).mock.calls.filter(([event]) => event === "chat"))
          .toHaveLength(0);
        expect.soft(context.logGateway.error).toHaveBeenCalledOnce();
      }
      if (outcome === "aborted") {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
          }),
          undefined,
          { runId },
        );
        if (preparation === "stage" && stageError === "abort") {
          expect(stageSpy).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: signal }));
        } else if (preparation !== "stage") {
          expect(stageSpy).not.toHaveBeenCalled();
        }
      } else {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: expect.stringContaining(ordinaryFailure.message),
          }),
        );
        expect(context.logGateway.error).toHaveBeenCalledWith(
          "chat.send attachment parse/stage failed",
          expect.objectContaining({ error: expect.stringContaining(ordinaryFailure.message) }),
        );
        const failure = failureSpy.mock.calls[0]?.[2];
        expect(failure).toBeInstanceOf(attachments.MediaOffloadError);
        if (!(failure instanceof attachments.MediaOffloadError)) {
          throw new Error("staging failure lost its retryable attachment classification");
        }
        expect(failure.cause).toBe(ordinaryFailure);
      }
    } finally {
      stageRelease.resolve();
      cleanupRelease.resolve();
      try {
        await preparing;
      } finally {
        stageSpy.mockRestore();
        sandboxSpy?.mockRestore();
        parseSpy.mockRestore();
        discardSpy.mockRestore();
        failureSpy.mockRestore();
        admission.cleanupAdmittedRun();
        clearAgentRunContext(runId, admission.lifecycleGeneration);
        if (prepared?.ok) {
          await discard(prepared.value.offloadedRefs);
        }
      }
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import {
  readSessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import {
  createPlacementStartupHarness,
  createStartupPlacement,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";

describe("application placement delivery recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["rpc", "error", "timeout"] as const)(
    "delivery recovery rotates a cached %s rejection only on explicit Retry",
    async (failure) => {
      const rejection = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "send rejected",
      });
      const request = vi.fn((method: string, payload?: Record<string, unknown>) => {
        if (method === "sessions.dispatch") {
          return Promise.resolve({ placement: createStartupPlacement("active", 2) });
        }
        if (method === "sessions.reclaim") {
          return Promise.resolve({ ok: true });
        }
        if (method === "sessions.send") {
          if (payload?.idempotencyKey === "message-stable") {
            return failure === "rpc"
              ? Promise.reject(rejection)
              : Promise.resolve({ runId: "message-stable", status: failure });
          }
          return Promise.resolve({ runId: payload?.idempotencyKey, status: "started" });
        }
        throw new Error(`unexpected method ${method}`);
      });
      const { startup, input, initialUserMessage, client } = createPlacementStartupHarness(request);
      input.recovery = {
        ...input.recovery,
        target: { kind: "profile", profileId: "aws", machineClass: "fast" },
        attachments: [{ type: "file", mimeType: "text/plain", content: "SGk=" }],
      };
      writeSessionPlacementRecovery(input.recovery);
      startup.start(input);
      try {
        await vi.waitFor(() =>
          expect(startup.get(input.recovery.sessionKey)?.phase).toBe("failed"),
        );
        expect(initialUserMessage.read(input.recovery.sessionKey, client)).toBeNull();
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toMatchObject({ phase: "paused", reason: "rejected", messageId: "message-stable" });
        startup.retry(input.recovery.sessionKey);
        startup.retry(input.recovery.sessionKey);
        const replacement = readSessionPlacementRecovery(
          input.recovery.gatewayUrl,
          input.recovery.recoveryScope,
          input.recovery.sessionKey,
        );
        expect(replacement?.messageId).not.toBe(input.recovery.messageId);
        await vi.waitFor(() => expect(startup.get(input.recovery.sessionKey)).toBeNull());
        const sends = request.mock.calls.filter(([method]) => method === "sessions.send");
        expect(sends).toHaveLength(2);
        expect(sends[1]?.[1]).toMatchObject({
          key: input.recovery.sessionKey,
          message: input.recovery.message,
          attachments: input.recovery.attachments,
          idempotencyKey: expect.any(String),
        });
        expect(sends[1]?.[1]?.idempotencyKey).not.toBe("message-stable");
        expect(
          request.mock.calls
            .filter(([method]) => method === "sessions.dispatch")
            .map(([, payload]) => payload),
        ).toEqual(
          [1, 2].map(() => ({
            key: input.recovery.sessionKey,
            agentId: input.recovery.agentId,
            profileId: "aws",
            machineClass: "fast",
          })),
        );
        expect(initialUserMessage.read(input.recovery.sessionKey, client)?.pendingRunId).toBe(
          sends[1]?.[1]?.idempotencyKey,
        );
      } finally {
        startup.dispose();
      }
    },
  );

  it.each(["active", "local", "failed", "reclaimed"])(
    "delivery recovery checks uncertain sending without mutating %s placement",
    async (state) => {
      const request = vi.fn((method: string) => {
        if (method === "chat.history") {
          return Promise.resolve({ messages: [] });
        }
        if (method === "sessions.describe") {
          return Promise.resolve({ session: { placement: createStartupPlacement(state, 2) } });
        }
        return Promise.resolve({ status: "started" });
      });
      const { startup, input, dependencies } = createPlacementStartupHarness(request);
      const attachments = [
        { type: "file", mimeType: "text/plain", fileName: "note.txt", content: "SGk=" },
      ];
      input.recovery = { ...input.recovery, phase: "sending", attachments };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      try {
        await vi.waitFor(() =>
          expect(startup.get(input.recovery.sessionKey)).toMatchObject({
            phase: "failed",
            action: "check-delivery",
            initialTurn: {
              text: input.recovery.message,
              sendState: "unconfirmed",
              attachments: [{ dataUrl: "data:text/plain;base64,SGk=" }],
            },
          }),
        );
        startup.retry(input.recovery.sessionKey);
        startup.retry(input.recovery.sessionKey);
        await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
        expect(request.mock.calls.every(([method]) => method === "chat.history")).toBe(true);
        expect(request).toHaveBeenCalledWith(
          "chat.history",
          expect.objectContaining({ sessionKey: input.recovery.sessionKey, limit: 1000 }),
        );
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toMatchObject({
          phase: "paused",
          reason: "unconfirmed",
          messageId: input.recovery.messageId,
          attachments,
        });
        startup.dispose();
        const reloaded = createApplicationPlacementStartup(dependencies);
        reloaded.resumeRecovery();
        try {
          await vi.waitFor(() =>
            expect(reloaded.get(input.recovery.sessionKey)).toMatchObject({
              action: "check-delivery",
              initialTurn: { text: input.recovery.message, sendRunId: input.recovery.messageId },
            }),
          );
          expect(request).toHaveBeenCalledTimes(2);
        } finally {
          reloaded.dispose();
        }
      } finally {
        startup.dispose();
      }
    },
  );

  it.each(["exact-user", "assistant", "same-text", "unavailable"])(
    "delivery recovery settles only an exact user receipt (%s)",
    async (evidence) => {
      const request = vi.fn((method: string) => {
        if (method === "chat.history") {
          if (evidence === "unavailable") {
            return Promise.reject(new Error("history unavailable"));
          }
          return Promise.resolve({
            messages: [
              {
                role: evidence === "assistant" ? "assistant" : "user",
                content: [{ type: "text", text: "fix the cloud task" }],
                __openclaw: {
                  idempotencyKey: evidence === "same-text" ? "other:user" : "message-stable:user",
                },
              },
            ],
          });
        }
        if (method === "sessions.describe") {
          return Promise.resolve({ session: { placement: createStartupPlacement("active", 1) } });
        }
        return Promise.resolve({ status: "started" });
      });
      const { startup, input, initialUserMessage, client } = createPlacementStartupHarness(request);
      input.recovery = { ...input.recovery, phase: "sending" };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      try {
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("chat.history", expect.anything()),
        );
        await vi.waitFor(() => {
          if (evidence === "exact-user") {
            expect(startup.get(input.recovery.sessionKey)).toBeNull();
            expect(initialUserMessage.read(input.recovery.sessionKey, client)?.pendingRunId).toBe(
              input.recovery.messageId,
            );
          } else {
            expect(startup.get(input.recovery.sessionKey)).toMatchObject({
              phase: "failed",
              action: "check-delivery",
              initialTurn: { text: input.recovery.message },
            });
          }
        });
        expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
        const stored = readSessionPlacementRecovery(
          input.recovery.gatewayUrl,
          input.recovery.recoveryScope,
          input.recovery.sessionKey,
        );
        if (evidence === "exact-user") {
          expect(stored).toBeNull();
        } else {
          expect(stored).toMatchObject({
            phase: "paused",
            reason: "unconfirmed",
            messageId: input.recovery.messageId,
          });
        }
      } finally {
        startup.dispose();
      }
    },
  );

  it.each(["message", "credential"])(
    "delivery recovery fences a stale observation after %s ownership changes",
    async (changed) => {
      const history = createDeferred<{ messages: unknown[] }>();
      const request = vi.fn((method: string) => {
        if (method === "chat.history") {
          return history.promise;
        }
        if (method === "sessions.describe") {
          return Promise.resolve({ session: { placement: createStartupPlacement("active", 1) } });
        }
        return Promise.resolve({ status: "started" });
      });
      const { startup, input, client, initialUserMessage } = createPlacementStartupHarness(request);
      input.recovery = { ...input.recovery, phase: "sending" };
      writeSessionPlacementRecovery(input.recovery);
      startup.resumeRecovery();
      try {
        await vi.waitFor(() =>
          expect(request).toHaveBeenCalledWith("chat.history", expect.anything()),
        );
        const retained =
          changed === "message"
            ? { ...input.recovery, messageId: "new-owner", message: "new submission" }
            : input.recovery;
        writeSessionPlacementRecovery(retained);
        if (changed === "credential") {
          client.recoveryScope = "principal-b";
        }
        expect(startup.get(input.recovery.sessionKey)).toBeNull();
        history.resolve({
          messages: [{ role: "user", __openclaw: { idempotencyKey: "message-stable:user" } }],
        });
        await flushStartupMicrotasks();
        expect(
          readSessionPlacementRecovery(
            input.recovery.gatewayUrl,
            input.recovery.recoveryScope,
            input.recovery.sessionKey,
          ),
        ).toEqual(retained);
        expect(initialUserMessage.read(input.recovery.sessionKey, client)).toBeNull();
        expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
      } finally {
        startup.dispose();
      }
    },
  );
});

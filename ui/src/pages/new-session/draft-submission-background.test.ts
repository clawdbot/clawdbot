import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeNotificationsCapability } from "../../app/native-notifications.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import * as toast from "../../lib/toast.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

function nativeBackgroundFixture(options: Parameters<typeof createDraftFixture>[0] = {}) {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawNotifications: { postMessage } },
  });
  const nativeNotifications = createNativeNotificationsCapability();
  const fixture = createDraftFixture(options);
  Object.assign(fixture.context, { nativeNotifications, basePath: "" });
  vi.mocked(fixture.context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:background",
    initialRun: { status: "started", runId: "run-background" },
  });
  fixture.flow.setMessage("finish in the background");
  return { ...fixture, postMessage, dispose: () => nativeNotifications?.dispose() };
}

function failedPlacement(
  sendState: "failed" | "unconfirmed",
  sendRunId = "run-background",
  error?: string,
): ApplicationPlacementStartupStatus {
  return {
    sessionKey: "agent:main:dashboard:background",
    targetKind: "device",
    phase: "failed",
    startedAt: 1,
    error,
    initialTurn: {
      id: sendRunId,
      text: "background turn",
      createdAt: 1,
      sendRunId,
      sendState,
      sendError: error,
    },
  };
}

describe("DraftSubmissionFlow background completion", () => {
  it("delivers an accepted background completion before the first native status reply", async () => {
    const { context, flow, postMessage, dispose } = nativeBackgroundFixture({
      request: async (method) => (method === "agent.wait" ? { status: "ok", endedAt: 1 } : {}),
    });
    try {
      await flow.submit(undefined, true);
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
      expect(postMessage).toHaveBeenLastCalledWith({
        type: "background-session-completed",
        runId: "run-background",
        path: "/chat/main/dashboard/background",
      });
      expect(context.navigateAndWait).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it.each(["selected session", "replaced Gateway"])(
    "suppresses a background completion for the %s",
    async (scenario) => {
      const { context, flow, request, postMessage, dispose } = nativeBackgroundFixture();
      request.mockImplementation(async (method) => {
        if (method === "agent.wait") {
          if (scenario === "selected session") {
            context.gateway.snapshot.sessionKey = "agent:main:dashboard:background";
          } else {
            context.gateway.snapshot.client = null;
          }
          return { status: "ok", endedAt: 1 };
        }
        return {};
      });
      try {
        await flow.submit(undefined, true);
        await Promise.resolve();
        expect(postMessage.mock.calls).toEqual([[{ type: "status" }]]);
      } finally {
        dispose();
      }
    },
  );

  it.each([
    { scenario: "an observation deadline", observed: { status: "timeout" }, placement: null },
    {
      scenario: "a retryable provider error",
      observed: { status: "timeout", error: "Retryable provider failure", pendingError: true },
      placement: null,
    },
    { scenario: "a queued turn", observed: { status: "pending" }, placement: null },
    {
      scenario: "checking placement delivery",
      observed: { status: "timeout" },
      placement: failedPlacement("unconfirmed"),
    },
    {
      scenario: "paused unconfirmed placement delivery",
      observed: { status: "timeout" },
      placement: failedPlacement("unconfirmed", "run-background", "Delivery remains unconfirmed"),
    },
    {
      scenario: "a newer placement retry failure",
      observed: { status: "timeout" },
      placement: failedPlacement("failed", "newer-run", "Newer retry rejected"),
    },
    {
      scenario: "a placement display error without a recorded send outcome",
      observed: { status: "timeout" },
      placement: { ...failedPlacement("failed"), initialTurn: undefined },
    },
  ])(
    "waits for terminal background completion after $scenario",
    async ({ observed, placement }) => {
      vi.useFakeTimers();
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      let finishRun!: (result: { status: "ok"; endedAt: number }) => void;
      const terminal = new Promise<{ status: "ok"; endedAt: number }>((resolve) => {
        finishRun = resolve;
      });
      const observations = [Promise.resolve(observed), terminal];
      const { context, flow, request, postMessage, dispose } = nativeBackgroundFixture({
        request: async (method) => (method === "agent.wait" ? observations.shift() : {}),
      });

      Object.assign(context.placementStartup, { get: () => placement });

      try {
        await flow.submit(undefined, true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(postMessage.mock.calls).toEqual([[{ type: "status" }]]);
        expect(showToast).not.toHaveBeenCalled();
        expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(2);

        finishRun({ status: "ok", endedAt: 1 });
        await vi.advanceTimersByTimeAsync(0);
        expect(postMessage.mock.calls).toEqual([
          [{ type: "status" }],
          [
            {
              type: "background-session-completed",
              runId: "run-background",
              path: "/chat/main/dashboard/background",
            },
          ],
        ]);
        expect(showToast).toHaveBeenCalledOnce();
      } finally {
        context.gateway.snapshot.client = null;
        finishRun({ status: "ok", endedAt: 1 });
        await vi.advanceTimersByTimeAsync(0);
        dispose();
      }
    },
  );

  it("notifies a confirmed placement failure for the exact background run", async () => {
    const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
    const { context, flow, request, postMessage, dispose } = nativeBackgroundFixture({
      request: async (method) => (method === "agent.wait" ? { status: "timeout" } : {}),
    });
    Object.assign(context.placementStartup, {
      get: () => failedPlacement("failed", "run-background", "Placement rejected"),
    });
    try {
      await flow.submit(undefined, true);
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
      expect(postMessage).toHaveBeenLastCalledWith({
        type: "background-session-completed",
        runId: "run-background",
        path: "/chat/main/dashboard/background",
      });
      expect(showToast).toHaveBeenCalledOnce();
      expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(1);
    } finally {
      dispose();
    }
  });
});

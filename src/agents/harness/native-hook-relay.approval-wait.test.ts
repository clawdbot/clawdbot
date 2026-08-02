// Covers provider fallback when a run-scoped native hook approval cannot decide.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunPluginApprovalHost } from "../agent-run-approval.js";
import { invokeNativeHookRelay, registerNativeHookRelay, testing } from "./native-hook-relay.js";

afterEach(() => {
  vi.restoreAllMocks();
  testing.clearNativeHookRelaysForTests();
});

async function invokePermissionRequest(params: {
  request?: AgentRunPluginApprovalHost["request"];
  signal?: AbortSignal;
}) {
  const relay = registerNativeHookRelay({
    provider: "codex",
    sessionId: "session-1",
    runId: "run-1",
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.request
      ? { approvalContext: { approvalHost: { plugin: { request: params.request } } } }
      : {}),
  });
  return invokeNativeHookRelay({
    provider: "codex",
    relayId: relay.relayId,
    event: "permission_request",
    rawPayload: {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "cat /tmp/private-key" },
    },
  });
}

describe("native hook relay approval fallback", () => {
  it.each([
    {
      name: "has no approval host",
      request: undefined,
    },
    {
      name: "times out",
      request: vi.fn<AgentRunPluginApprovalHost["request"]>(async () => ({
        outcome: "timed-out",
      })),
    },
    {
      name: "reports unavailable",
      request: vi.fn<AgentRunPluginApprovalHost["request"]>(async () => ({
        outcome: "unavailable",
        reason: "no reviewer",
      })),
    },
  ])("defers to the provider when the run $name", async ({ request }) => {
    await expect(invokePermissionRequest({ request })).resolves.toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  it("defers to the provider when the approval host fails", async () => {
    const request = vi.fn<AgentRunPluginApprovalHost["request"]>(async () => {
      throw new Error("approval transport failed");
    });

    await expect(invokePermissionRequest({ request })).resolves.toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  it("passes cancellation to the approval host and defers after cancellation", async () => {
    const abortController = new AbortController();
    const request = vi.fn<AgentRunPluginApprovalHost["request"]>(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              const reason = signal.reason;
              reject(
                reason instanceof Error ? reason : new Error("approval aborted", { cause: reason }),
              );
            },
            { once: true },
          );
        }),
    );

    const response = invokePermissionRequest({
      request,
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    abortController.abort(new Error("run cancelled"));

    await expect(response).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(request.mock.calls[0]?.[0].signal).toBe(abortController.signal);
  });

  it("defers when the host resolves allow after the run is cancelled", async () => {
    const abortController = new AbortController();
    const request = vi.fn<AgentRunPluginApprovalHost["request"]>(async () => {
      abortController.abort(new Error("run cancelled"));
      return { outcome: "resolved", decision: "allow-once" };
    });

    await expect(
      invokePermissionRequest({
        request,
        signal: abortController.signal,
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });
});

// Control UI tests cover exec approval behavior.
import { describe, expect, it, vi } from "vitest";
import {
  enqueueExecApprovalPrompt,
  isStaleApprovalResolutionError,
  parseApprovalRequestedEvent,
  clearResolvedExecApprovalPrompt,
  refreshPendingApprovalQueue,
  type ExecApprovalPromptState,
  type ExecApprovalRequest,
} from "./exec-approval.ts";

const parseExecApprovalRequested = (payload: unknown) =>
  parseApprovalRequestedEvent("exec.approval.requested", payload);
const parsePluginApprovalRequested = (payload: unknown) =>
  parseApprovalRequestedEvent("plugin.approval.requested", payload);
const parseSystemAgentApprovalRequested = (payload: unknown) =>
  parseApprovalRequestedEvent("openclaw.approval.requested", payload);

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createExecApproval(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "exec",
    request: { command: "echo hello" },
    createdAtMs: 1000,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

function createPromptState(
  request: RequestFn,
  queue: ExecApprovalRequest[] = [createExecApproval()],
): ExecApprovalPromptState {
  return {
    client: { request },
    execApprovalQueue: queue,
    execApprovalBusy: false,
    execApprovalError: null,
  };
}

function createGatewayError(message: string, details?: unknown): Error {
  const err = new Error(message);
  Object.defineProperty(err, "gatewayCode", {
    value: "INVALID_REQUEST",
    enumerable: true,
  });
  Object.defineProperty(err, "details", {
    value: details,
    enumerable: true,
  });
  return err;
}

describe("parseExecApprovalRequested", () => {
  it("returns entries with kind 'exec'", () => {
    const result = parseExecApprovalRequested({
      id: "exec-1",
      request: { command: "rm -rf /" },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });
    expect(result?.kind).toBe("exec");
    expect(result?.request.command).toBe("rm -rf /");
  });

  it("preserves allowed approval decisions", () => {
    const result = parseExecApprovalRequested({
      id: "exec-1",
      request: {
        command: "pwd",
        allowedDecisions: ["allow-once", "bad", "deny", "allow-always"],
      },
      createdAtMs: 1000,
      expiresAtMs: 2000,
    });

    expect(result?.request.allowedDecisions).toEqual(["allow-once", "deny", "allow-always"]);
  });
});

describe("parsePluginApprovalRequested", () => {
  // Matches the actual gateway broadcast shape: title/description/severity/pluginId
  // are nested inside payload.request (PluginApprovalRequestPayload)
  const validPayload = {
    id: "plugin-1",
    createdAtMs: 1000,
    expiresAtMs: 120_000,
    request: {
      title: "Dangerous command detected",
      description: "chmod 777 script.sh modifies file permissions",
      severity: "high",
      pluginId: "sage",
      agentId: "agent-1",
      sessionKey: "sess-1",
    },
  };

  it("parses a valid payload", () => {
    const result = parsePluginApprovalRequested(validPayload);
    expect(result?.kind).toBe("plugin");
    expect(result?.pluginTitle).toBe("Dangerous command detected");
    expect(result?.pluginDescription).toBe("chmod 777 script.sh modifies file permissions");
    expect(result?.pluginSeverity).toBe("high");
    expect(result?.pluginId).toBe("sage");
    expect(result?.request.command).toBe("Dangerous command detected");
    expect(result?.request.agentId).toBe("agent-1");
    expect(result?.request.sessionKey).toBe("sess-1");
    expect(result?.createdAtMs).toBe(1000);
    expect(result?.expiresAtMs).toBe(120_000);
  });

  it("returns null when title is missing from request", () => {
    const {
      request: { title: _, ...restRequest },
      ...rest
    } = validPayload;
    expect(parsePluginApprovalRequested({ ...rest, request: restRequest })).toBeNull();
  });

  it("returns null when request is missing entirely", () => {
    const { request: _, ...noRequest } = validPayload;
    expect(parsePluginApprovalRequested(noRequest)).toBeNull();
  });

  it("returns null when id is missing", () => {
    const { id: _, ...noId } = validPayload;
    expect(parsePluginApprovalRequested(noId)).toBeNull();
  });

  it("returns null when timestamps are missing", () => {
    const { createdAtMs: _, expiresAtMs: __, ...noTimestamps } = validPayload;
    expect(parsePluginApprovalRequested(noTimestamps)).toBeNull();
  });

  it("returns null for null payload", () => {
    expect(parsePluginApprovalRequested(null)).toBeNull();
  });

  it("returns null for non-object payload", () => {
    expect(parsePluginApprovalRequested("not an object")).toBeNull();
  });

  it("handles missing optional fields gracefully", () => {
    const minimal = {
      id: "plugin-2",
      createdAtMs: 500,
      expiresAtMs: 60_000,
      request: { title: "Alert" },
    };
    const result = parsePluginApprovalRequested(minimal);
    expect(result?.kind).toBe("plugin");
    expect(result?.pluginTitle).toBe("Alert");
    expect(result?.pluginDescription).toBeNull();
    expect(result?.pluginSeverity).toBeNull();
    expect(result?.pluginId).toBeNull();
    expect(result?.request.agentId).toBeNull();
    expect(result?.request.sessionKey).toBeNull();
  });
});

describe("parseSystemAgentApprovalRequested", () => {
  it("keeps the exact proposal and only safe prompt fields", () => {
    const result = parseSystemAgentApprovalRequested({
      id: "system-agent:1",
      createdAtMs: 1000,
      expiresAtMs: 2000,
      request: {
        title: "OpenClaw change",
        description: "Set gateway.port to 19001",
        command: "Set gateway.port to 19001",
        proposalHash: "a".repeat(64),
        agentId: "main",
        sessionKey: "agent:main:main",
        allowedDecisions: ["allow-once", "deny", "allow-always"],
      },
    });

    expect(result).toMatchObject({
      id: "system-agent:1",
      kind: "system-agent",
      pluginTitle: "OpenClaw change",
      pluginDescription: "Set gateway.port to 19001",
      proposalHash: "a".repeat(64),
      request: {
        command: "Set gateway.port to 19001",
        agentId: "main",
        sessionKey: "agent:main:main",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
  });
});

describe("parseExecApprovalRequested command spans", () => {
  it("preserves command text spacing for span offsets", () => {
    const parsed = parseExecApprovalRequested({
      id: "approval-spaces-1",
      request: { command: "  python -c 'print(1)'" },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(parsed?.request.command).toBe("  python -c 'print(1)'");
  });

  it("rejects whitespace-only command text", () => {
    expect(
      parseExecApprovalRequested({
        id: "approval-blank-1",
        request: { command: "   " },
        createdAtMs: 1,
        expiresAtMs: 2,
      }),
    ).toBeNull();
  });

  it("preserves valid command spans from exec approval events", () => {
    const parsed = parseExecApprovalRequested({
      id: "approval-explain-1",
      request: {
        command: "ls | grep stuff",
        commandSpans: [
          { startIndex: 0, endIndex: 2 },
          { startIndex: 5, endIndex: 9 },
          { startIndex: 10, endIndex: 15 },
          { startIndex: 16, endIndex: 20 },
          { startIndex: -1, endIndex: 2 },
          { startIndex: 8, endIndex: 8 },
        ],
      },
      createdAtMs: 1,
      expiresAtMs: 2,
    });

    expect(parsed?.request.commandSpans).toEqual([
      { startIndex: 0, endIndex: 2 },
      { startIndex: 5, endIndex: 9 },
      { startIndex: 10, endIndex: 15 },
    ]);
  });
});

describe("isStaleApprovalResolutionError", () => {
  it("detects already-resolved approval errors", () => {
    expect(
      isStaleApprovalResolutionError(
        createGatewayError("approval already resolved", {
          reason: "APPROVAL_ALREADY_RESOLVED",
        }),
      ),
    ).toBe(true);
  });

  it("detects unknown or expired approval errors", () => {
    expect(
      isStaleApprovalResolutionError(createGatewayError("unknown or expired approval id")),
    ).toBe(true);
  });

  it("detects missing approval errors", () => {
    expect(
      isStaleApprovalResolutionError(
        createGatewayError("approval not found", {
          reason: "APPROVAL_NOT_FOUND",
        }),
      ),
    ).toBe(true);
  });

  it("ignores unrelated approval resolve errors", () => {
    expect(isStaleApprovalResolutionError(createGatewayError("gateway unavailable"))).toBe(false);
  });
});

describe("clearResolvedExecApprovalPrompt", () => {
  it("does not clear the active prompt error when another approval resolves", () => {
    const active = createExecApproval({ id: "approval-active", createdAtMs: 2 });
    const queued = createExecApproval({ id: "approval-queued", createdAtMs: 1 });
    const state = createPromptState(
      vi.fn<RequestFn>(async () => ({})),
      [active, queued],
    );
    state.execApprovalError = "Approval failed: Error: gateway unavailable";

    clearResolvedExecApprovalPrompt(state, "approval-queued");

    expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-active"]);
    expect(state.execApprovalError).toBe("Approval failed: Error: gateway unavailable");
  });

  it("clears the active prompt error when the active approval resolves", () => {
    const state = createPromptState(vi.fn<RequestFn>(async () => ({})));
    state.execApprovalError = "Approval failed: Error: gateway unavailable";

    clearResolvedExecApprovalPrompt(state, "approval-1");

    expect(state.execApprovalQueue).toEqual([]);
    expect(state.execApprovalError).toBeNull();
  });
});

describe("refreshPendingApprovalQueue", () => {
  it("keeps approvals received while a refresh is in flight", async () => {
    let resolveExecList: (value: unknown[]) => void = () => {};
    const execApprovalList = new Promise<unknown[]>((resolve) => {
      resolveExecList = resolve;
    });
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.list") {
        return execApprovalList;
      }
      if (method === "plugin.approval.list") {
        return [];
      }
      return {};
    });
    const state = createPromptState(request, []);

    const refreshPromise = refreshPendingApprovalQueue(state);
    enqueueExecApprovalPrompt(
      state,
      createExecApproval({ id: "approval-arrived-during-refresh", createdAtMs: 2000 }),
    );
    resolveExecList([]);
    await refreshPromise;

    expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual([
      "approval-arrived-during-refresh",
    ]);
    clearResolvedExecApprovalPrompt(state, "approval-arrived-during-refresh");
  });

  it("does not requeue approvals resolved while a refresh is in flight", async () => {
    let resolveExecList: (value: unknown[]) => void = () => {};
    const execApprovalList = new Promise<unknown[]>((resolve) => {
      resolveExecList = resolve;
    });
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.list") {
        return execApprovalList;
      }
      if (method === "plugin.approval.list") {
        return [];
      }
      return {};
    });
    const resolvingApproval = createExecApproval({ id: "approval-resolving" });
    const state = createPromptState(request, [resolvingApproval]);

    const refreshPromise = refreshPendingApprovalQueue(state);
    clearResolvedExecApprovalPrompt(state, "approval-resolving");
    resolveExecList([resolvingApproval]);
    await refreshPromise;

    expect(state.execApprovalQueue).toEqual([]);
  });

  it("does not requeue new approvals resolved before refresh completes", async () => {
    let resolveExecList: (value: unknown[]) => void = () => {};
    let resolvePluginList: (value: unknown[]) => void = () => {};
    const execApprovalList = new Promise<unknown[]>((resolve) => {
      resolveExecList = resolve;
    });
    const pluginApprovalList = new Promise<unknown[]>((resolve) => {
      resolvePluginList = resolve;
    });
    const request = vi.fn<RequestFn>(async (method) => {
      if (method === "exec.approval.list") {
        return execApprovalList;
      }
      if (method === "plugin.approval.list") {
        return pluginApprovalList;
      }
      return {};
    });
    const state = createPromptState(request, []);
    const transientApproval = createExecApproval({ id: "approval-transient" });

    const refreshPromise = refreshPendingApprovalQueue(state);
    enqueueExecApprovalPrompt(state, transientApproval);
    resolveExecList([transientApproval]);
    clearResolvedExecApprovalPrompt(state, "approval-transient");
    resolvePluginList([]);
    await refreshPromise;

    expect(state.execApprovalQueue).toEqual([]);
  });

  it("removes refreshed approvals after their expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));
    try {
      const expiresAtMs = Date.now() + 1_000;
      const request = vi.fn<RequestFn>(async (method) => {
        if (method === "exec.approval.list") {
          return [
            {
              id: "approval-refreshed-1",
              request: { command: "pnpm check:changed" },
              createdAtMs: Date.now(),
              expiresAtMs,
            },
          ];
        }
        if (method === "plugin.approval.list") {
          return [];
        }
        return {};
      });
      const state = createPromptState(request, []);

      await refreshPendingApprovalQueue(state);
      expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-refreshed-1"]);

      vi.advanceTimersByTime(1_500);

      expect(state.execApprovalQueue).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears active prompt errors when expiry advances the queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));
    try {
      const activeExpiresAtMs = Date.now() + 1_000;
      const queuedExpiresAtMs = Date.now() + 60_000;
      const request = vi.fn<RequestFn>(async (method) => {
        if (method === "exec.approval.list") {
          return [
            {
              id: "approval-active-expiring",
              request: { command: "pnpm check:changed" },
              createdAtMs: Date.now() + 1,
              expiresAtMs: activeExpiresAtMs,
            },
            {
              id: "approval-queued",
              request: { command: "pnpm test" },
              createdAtMs: Date.now(),
              expiresAtMs: queuedExpiresAtMs,
            },
          ];
        }
        if (method === "plugin.approval.list") {
          return [];
        }
        return {};
      });
      const state = createPromptState(request, []);

      await refreshPendingApprovalQueue(state);
      state.execApprovalError = "Approval failed: Error: gateway unavailable";

      vi.advanceTimersByTime(1_500);

      expect(state.execApprovalQueue.map((entry) => entry.id)).toEqual(["approval-queued"]);
      expect(state.execApprovalError).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not requeue expired approvals returned by refresh lists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T00:00:00.000Z"));
    try {
      const request = vi.fn<RequestFn>(async (method) => {
        if (method === "exec.approval.list") {
          return [
            {
              id: "approval-expired-1",
              request: { command: "pnpm check:changed" },
              createdAtMs: Date.now() - 2_000,
              expiresAtMs: Date.now() - 1_000,
            },
          ];
        }
        if (method === "plugin.approval.list") {
          return [];
        }
        return {};
      });
      const state = createPromptState(request, []);

      await refreshPendingApprovalQueue(state);

      expect(state.execApprovalQueue).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

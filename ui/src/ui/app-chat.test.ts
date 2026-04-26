/* @vitest-environment jsdom */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHost } from "./app-chat.ts";
import type { GatewaySessionRow, SessionsListResult } from "./types.ts";

const { setLastActiveSessionKeyMock } = vi.hoisted(() => ({
  setLastActiveSessionKeyMock: vi.fn(),
}));

vi.mock("./app-last-active-session.ts", () => ({
  setLastActiveSessionKey: (...args: unknown[]) => setLastActiveSessionKeyMock(...args),
}));

let handleSendChat: typeof import("./app-chat.ts").handleSendChat;
let steerQueuedChatMessage: typeof import("./app-chat.ts").steerQueuedChatMessage;
let handleAbortChat: typeof import("./app-chat.ts").handleAbortChat;
let refreshChatAvatar: typeof import("./app-chat.ts").refreshChatAvatar;
let clearPendingQueueItemsForRun: typeof import("./app-chat.ts").clearPendingQueueItemsForRun;

async function loadChatHelpers(): Promise<void> {
  ({
    handleSendChat,
    steerQueuedChatMessage,
    handleAbortChat,
    refreshChatAvatar,
    clearPendingQueueItemsForRun,
  } = await import("./app-chat.ts"));
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function makeHost(overrides?: Partial<ChatHost>): ChatHost {
  return {
    client: null,
    chatMessages: [],
    chatStream: null,
    connected: true,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    lastError: null,
    sessionKey: "agent:main",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    chatAvatarSource: null,
    chatAvatarStatus: null,
    chatAvatarReason: null,
    chatSideResult: null,
    chatSideResultTerminalRuns: new Set<string>(),
    chatModelOverrides: {},
    chatModelsLoading: false,
    chatModelCatalog: [],
    refreshSessionsAfterChat: new Set<string>(),
    updateComplete: Promise.resolve(),
    ...overrides,
  };
}

function createSessionsResult(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function row(key: string, overrides?: Partial<GatewaySessionRow>): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    updatedAt: null,
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("refreshChatAvatar", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a route-relative avatar endpoint before basePath bootstrap finishes", async () => {
    const createObjectURL = vi.fn(() => "blob:local-avatar");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === "/avatar/main?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ avatarUrl: "/avatar/main" }),
        });
      }
      if (url === "/avatar/main") {
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(["avatar"]),
        });
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:main" });
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledWith(
      "/avatar/main?meta=1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/avatar/main",
      expect.objectContaining({ method: "GET" }),
    );
    const avatarFetchInit = (
      fetchMock.mock.calls as Array<[string | URL | Request, RequestInit?]>
    )[1]?.[1];
    expect(avatarFetchInit).not.toHaveProperty("headers");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(host.chatAvatarUrl).toBe("blob:local-avatar");
  });

  it("prefers the paired device token for avatar metadata and local avatar URLs", async () => {
    const createObjectURL = vi.fn(() => "blob:device-avatar");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === "/openclaw/avatar/main?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ avatarUrl: "/avatar/main" }),
        });
      }
      if (url === "/avatar/main") {
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(["avatar"]),
        });
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({
      basePath: "/openclaw/",
      sessionKey: "agent:main",
      settings: { token: "session-token" },
      password: "shared-password",
      hello: { auth: { deviceToken: "device-token" } } as ChatHost["hello"],
    });
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledWith(
      "/openclaw/avatar/main?meta=1",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer device-token" },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/avatar/main",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer device-token" },
      }),
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(host.chatAvatarUrl).toBe("blob:device-avatar");
  });

  it("fetches local avatars through Authorization headers instead of tokenized URLs", async () => {
    const createObjectURL = vi.fn(() => "blob:session-avatar");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === "/openclaw/avatar/main?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ avatarUrl: "/avatar/main" }),
        });
      }
      if (url === "/avatar/main") {
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(["avatar"]),
        });
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({
      basePath: "/openclaw/",
      sessionKey: "agent:main",
      settings: { token: "session-token" },
    });
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledWith(
      "/openclaw/avatar/main?meta=1",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer session-token" },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/avatar/main",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer session-token" },
      }),
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(host.chatAvatarUrl).toBe("blob:session-avatar");
  });

  it("keeps mounted dashboard avatar endpoints under the normalized base path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "/openclaw/", sessionKey: "agent:ops:main" });
    await refreshChatAvatar(host);

    expect(fetchMock).toHaveBeenCalledWith(
      "/openclaw/avatar/ops?meta=1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(host.chatAvatarUrl).toBeNull();
  });

  it("drops remote avatar metadata so the control UI can rely on same-origin images only", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        avatarUrl: "https://example.com/avatar.png",
        avatarSource: "https://example.com/avatar.png",
        avatarStatus: "remote",
        avatarReason: null,
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:main" });
    await refreshChatAvatar(host);

    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarSource).toBe("https://example.com/avatar.png");
    expect(host.chatAvatarStatus).toBe("remote");
  });

  it("keeps unresolved IDENTITY.md avatar metadata when falling back to the logo", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        avatarUrl: null,
        avatarSource: "assets/avatars/nova-portrait.png",
        avatarStatus: "none",
        avatarReason: "missing",
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:main" });
    await refreshChatAvatar(host);

    expect(host.chatAvatarUrl).toBeNull();
    expect(host.chatAvatarSource).toBe("assets/avatars/nova-portrait.png");
    expect(host.chatAvatarStatus).toBe("none");
    expect(host.chatAvatarReason).toBe("missing");
  });

  it("ignores stale avatar responses after switching sessions", async () => {
    const createObjectURL = vi.fn(() => "blob:ops-avatar");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    const mainRequest = createDeferred<{ avatarUrl?: string }>();
    const opsRequest = createDeferred<{ avatarUrl?: string }>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url === "/avatar/main?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => mainRequest.promise,
        });
      }
      if (url === "/avatar/ops?meta=1") {
        return Promise.resolve({
          ok: true,
          json: async () => opsRequest.promise,
        });
      }
      if (url === "/avatar/ops") {
        return Promise.resolve({
          ok: true,
          blob: async () => new Blob(["avatar"]),
        });
      }
      throw new Error(`Unexpected avatar URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const host = makeHost({ basePath: "", sessionKey: "agent:main:main" });

    const firstRefresh = refreshChatAvatar(host);
    host.sessionKey = "agent:ops:main";
    const secondRefresh = refreshChatAvatar(host);

    mainRequest.resolve({ avatarUrl: "/avatar/main" });
    await firstRefresh;
    expect(host.chatAvatarUrl).toBeNull();

    opsRequest.resolve({ avatarUrl: "/avatar/ops" });
    await secondRefresh;

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(host.chatAvatarUrl).toBe("blob:ops-avatar");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/avatar/main?meta=1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/avatar/ops?meta=1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/avatar/ops",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("handleSendChat", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  beforeEach(() => {
    setLastActiveSessionKeyMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps slash-command model changes in sync with the chat header cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({}),
      }) as unknown as typeof fetch,
    );
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          key: "main",
          resolved: {
            modelProvider: "openai",
            model: "gpt-5-mini",
          },
        };
      }
      if (method === "chat.history") {
        return { messages: [], thinkingLevel: null };
      }
      if (method === "sessions.list") {
        return {
          ts: 0,
          path: "",
          count: 0,
          defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
          sessions: [],
        };
      }
      if (method === "models.list") {
        return {
          models: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const onSlashAction = vi.fn();
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      chatMessage: "/model gpt-5-mini",
      onSlashAction,
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "main",
      model: "gpt-5-mini",
    });
    expect(host.chatModelOverrides.main).toEqual({
      kind: "qualified",
      value: "openai/gpt-5-mini",
    });
    expect(onSlashAction).toHaveBeenCalledWith("refresh-tools-effective");
  });

  it("sends /btw immediately while a main run is active without queueing it", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-main",
      chatStream: "Working...",
      chatMessage: "/btw what changed?",
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:main",
        message: "/btw what changed?",
        deliver: false,
        idempotencyKey: expect.any(String),
      }),
    );
    expect(host.chatQueue).toEqual([]);
    expect(host.chatRunId).toBe("run-main");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatMessages).toEqual([]);
    expect(host.chatMessage).toBe("");
  });

  it("sends /btw without adopting a main chat run when idle", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatMessage: "/btw summarize this",
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        message: "/btw summarize this",
        deliver: false,
      }),
    );
    expect(host.chatRunId).toBeNull();
    expect(host.chatMessages).toEqual([]);
    expect(host.chatMessage).toBe("");
  });

  it("restores the BTW draft when detached send fails", async () => {
    const host = makeHost({
      client: {
        request: vi.fn(async (method: string) => {
          if (method === "chat.send") {
            throw new Error("network down");
          }
          throw new Error(`Unexpected request: ${method}`);
        }),
      } as unknown as ChatHost["client"],
      chatRunId: "run-main",
      chatStream: "Working...",
      chatMessage: "/btw what changed?",
    });

    await handleSendChat(host);

    expect(host.chatQueue).toEqual([]);
    expect(host.chatRunId).toBe("run-main");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatMessage).toBe("/btw what changed?");
    expect(host.lastError).toContain("network down");
  });

  it("clears BTW side results when /clear resets chat history", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.reset") {
        return { ok: true };
      }
      if (method === "chat.history") {
        return { messages: [], thinkingLevel: null };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      sessionKey: "main",
      chatMessage: "/clear",
      chatMessages: [{ role: "user", content: "hello", timestamp: 1 }],
      chatSideResult: {
        kind: "btw",
        runId: "btw-run-clear",
        sessionKey: "main",
        question: "what changed?",
        text: "Detached BTW result",
        isError: false,
        ts: 1,
      },
      chatSideResultTerminalRuns: new Set(["btw-run-clear"]),
    });

    await handleSendChat(host);

    expect(request).toHaveBeenCalledWith("sessions.reset", { key: "main" });
    expect(host.chatMessages).toEqual([]);
    expect(host.chatSideResult).toBeNull();
    expect(host.chatSideResultTerminalRuns?.size).toBe(0);
    expect(host.chatRunId).toBeNull();
    expect(host.chatStream).toBeNull();
  });

  it("shows a visible pending item for /steer on the active run", async () => {
    const host = makeHost({
      client: {
        request: vi.fn(async (method: string) => {
          if (method === "chat.send") {
            return { status: "started", runId: "run-1", messageSeq: 2 };
          }
          throw new Error(`Unexpected request: ${method}`);
        }),
      } as unknown as ChatHost["client"],
      chatRunId: "run-1",
      chatMessage: "/steer tighten the plan",
      sessionKey: "agent:main:main",
      sessionsResult: createSessionsResult([row("agent:main:main", { status: "running" })]),
    });

    await handleSendChat(host);

    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        text: "/steer tighten the plan",
        kind: "steered",
        pendingRunId: "run-1",
      }),
    ]);
  });

  it("steers a queued message into the active run without replacing run tracking", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "chat.send") {
        return { status: "started", runId: "steer-run" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const host = makeHost({
      client: { request } as unknown as ChatHost["client"],
      chatRunId: "run-1",
      chatStream: "Working...",
      chatQueue: [{ id: "queued-1", text: "tighten the plan", createdAt: 1 }],
      sessionKey: "agent:main:main",
    });

    await steerQueuedChatMessage(host, "queued-1");

    expect(request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "agent:main:main",
      message: "tighten the plan",
      deliver: false,
      idempotencyKey: expect.any(String),
      attachments: undefined,
    });
    expect(host.chatRunId).toBe("run-1");
    expect(host.chatStream).toBe("Working...");
    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        text: "tighten the plan",
        kind: "steered",
        pendingRunId: "run-1",
      }),
    ]);
  });

  it("removes pending steer indicators when the run finishes", async () => {
    const host = makeHost({
      chatQueue: [
        {
          id: "pending",
          text: "/steer tighten the plan",
          createdAt: 1,
          pendingRunId: "run-1",
        },
        {
          id: "queued",
          text: "follow up",
          createdAt: 2,
        },
      ],
    });

    clearPendingQueueItemsForRun(host, "run-1");

    expect(host.chatQueue).toEqual([
      expect.objectContaining({
        id: "queued",
        text: "follow up",
      }),
    ]);
  });
});

describe("handleAbortChat", () => {
  beforeAll(async () => {
    await loadChatHelpers();
  });

  it("queues the active run abort while disconnected", async () => {
    const host = makeHost({
      connected: false,
      chatRunId: "run-main",
      chatMessage: "draft",
      sessionKey: "agent:main",
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toEqual({ runId: "run-main", sessionKey: "agent:main" });
    expect(host.chatMessage).toBe("");
    expect(host.chatRunId).toBe("run-main");
  });

  it("keeps the draft when disconnected without an active run", async () => {
    const host = makeHost({
      connected: false,
      chatRunId: null,
      chatMessage: "draft",
    });

    await handleAbortChat(host);

    expect(host.pendingAbort).toBeUndefined();
    expect(host.chatMessage).toBe("draft");
  });
});

afterAll(() => {
  vi.doUnmock("./app-last-active-session.ts");
  vi.resetModules();
});

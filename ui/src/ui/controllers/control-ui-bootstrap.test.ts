/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../../src/gateway/control-ui-contract.js";
import { loadControlUiBootstrapConfig } from "./control-ui-bootstrap.ts";

function requireFetchCall(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const call = fetchMock.mock.calls[index] as [string, RequestInit] | undefined;
  if (!call) {
    throw new Error(`expected fetch call #${index + 1}`);
  }
  return { url: call[0], init: call[1], headers: call[1].headers as Record<string, string> };
}

describe("loadControlUiBootstrapConfig", () => {
  it("loads assistant identity from the bootstrap endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        basePath: "/openclaw",
        assistantName: "Ops",
        assistantAvatar: "O",
        assistantAvatarSource: "avatars/ops.png",
        assistantAvatarStatus: "none",
        assistantAvatarReason: "missing",
        assistantAgentId: "main",
        serverVersion: "2026.3.7",
        localMediaPreviewRoots: ["/tmp/openclaw"],
        embedSandbox: "scripts",
        allowExternalEmbedUrls: true,
        chatMessageMaxWidth: "min(1280px, 82%)",
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "/openclaw",
      assistantName: "Assistant",
      assistantAvatar: null,
      assistantAvatarSource: null,
      assistantAvatarStatus: null,
      assistantAvatarReason: null,
      assistantAgentId: null,
      localMediaPreviewRoots: [],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
      chatMessageMaxWidth: null,
      serverVersion: null,
    };

    await loadControlUiBootstrapConfig(state);

    const fetchCall = requireFetchCall(fetchMock);
    expect(fetchCall.url).toBe(`/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`);
    expect(fetchCall.init.method).toBe("GET");
    expect(state.assistantName).toBe("Ops");
    expect(state.assistantAvatar).toBe("O");
    expect(state.assistantAvatarSource).toBe("avatars/ops.png");
    expect(state.assistantAvatarStatus).toBe("none");
    expect(state.assistantAvatarReason).toBe("missing");
    expect(state.assistantAgentId).toBe("main");
    expect(state.serverVersion).toBe("2026.3.7");
    expect(state.localMediaPreviewRoots).toEqual(["/tmp/openclaw"]);
    expect(state.embedSandboxMode).toBe("scripts");
    expect(state.allowExternalEmbedUrls).toBe(true);
    expect(state.chatMessageMaxWidth).toBe("min(1280px, 82%)");

    vi.unstubAllGlobals();
  });

  it("can refresh runtime bootstrap settings without clobbering session identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        basePath: "",
        assistantName: "Main",
        assistantAvatar: "M",
        assistantAgentId: "main",
        serverVersion: "2026.4.27",
        localMediaPreviewRoots: ["/tmp/openclaw"],
        embedSandbox: "trusted",
        allowExternalEmbedUrls: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "",
      assistantName: "Worker",
      assistantAvatar: "W",
      assistantAvatarSource: null,
      assistantAvatarStatus: null,
      assistantAvatarReason: null,
      assistantAgentId: "worker",
      localMediaPreviewRoots: [],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
      serverVersion: null,
    };

    await loadControlUiBootstrapConfig(state, { applyIdentity: false });

    expect(state.assistantName).toBe("Worker");
    expect(state.assistantAvatar).toBe("W");
    expect(state.assistantAgentId).toBe("worker");
    expect(state.serverVersion).toBe("2026.4.27");
    expect(state.localMediaPreviewRoots).toEqual(["/tmp/openclaw"]);
    expect(state.embedSandboxMode).toBe("trusted");
    expect(state.allowExternalEmbedUrls).toBe(true);

    vi.unstubAllGlobals();
  });

  it("does not apply default-agent bootstrap identity to an active non-default session", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        basePath: "",
        assistantName: "AI大管家",
        assistantAvatar: "M",
        assistantAgentId: "main",
        serverVersion: "2026.4.27",
        localMediaPreviewRoots: ["/tmp/openclaw"],
        embedSandbox: "trusted",
        allowExternalEmbedUrls: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "",
      sessionKey: "agent:fs-daying:main",
      assistantName: "大颖",
      assistantAvatar: "D",
      assistantAvatarSource: null,
      assistantAvatarStatus: null,
      assistantAvatarReason: null,
      assistantAgentId: "fs-daying",
      localMediaPreviewRoots: [],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
      serverVersion: null,
    };

    await loadControlUiBootstrapConfig(state);

    expect(state.assistantName).toBe("大颖");
    expect(state.assistantAvatar).toBe("D");
    expect(state.assistantAgentId).toBe("fs-daying");
    expect(state.serverVersion).toBe("2026.4.27");
    expect(state.localMediaPreviewRoots).toEqual(["/tmp/openclaw"]);
    expect(state.embedSandboxMode).toBe("trusted");
    expect(state.allowExternalEmbedUrls).toBe(true);

    vi.unstubAllGlobals();
  });

  it("keeps local assistant avatar override when default-agent bootstrap identity is skipped", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        basePath: "",
        assistantName: "Main",
        assistantAvatar: "M",
        assistantAgentId: "main",
        serverVersion: "2026.4.27",
        localMediaPreviewRoots: [],
        embedSandbox: "scripts",
        allowExternalEmbedUrls: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => JSON.stringify({ avatar: "data:image/png;base64,local" })),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as Storage);

    const state = {
      basePath: "",
      sessionKey: "agent:worker:main",
      assistantName: "Worker",
      assistantAvatar: "W",
      assistantAvatarSource: null,
      assistantAvatarStatus: null,
      assistantAvatarReason: null,
      assistantAgentId: "worker",
      localMediaPreviewRoots: [],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
      serverVersion: null,
    };

    await loadControlUiBootstrapConfig(state);

    expect(state.assistantName).toBe("Worker");
    expect(state.assistantAvatar).toBe("data:image/png;base64,local");
    expect(state.assistantAvatarSource).toBe("data:image/png;base64,local");
    expect(state.assistantAvatarStatus).toBe("data");
    expect(state.assistantAvatarReason).toBeNull();
    expect(state.assistantAgentId).toBe("worker");

    vi.unstubAllGlobals();
  });

  it("ignores failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "",
      assistantName: "Assistant",
      assistantAvatar: null,
      assistantAgentId: null,
      localMediaPreviewRoots: [],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
      serverVersion: null,
    };

    await loadControlUiBootstrapConfig(state);

    const fetchCall = requireFetchCall(fetchMock);
    expect(fetchCall.url).toBe(CONTROL_UI_BOOTSTRAP_CONFIG_PATH);
    expect(fetchCall.init.method).toBe("GET");
    expect(state.assistantName).toBe("Assistant");
    expect(state.embedSandboxMode).toBe("scripts");
    expect(state.allowExternalEmbedUrls).toBe(false);

    vi.unstubAllGlobals();
  });

  it("normalizes trailing slash basePath for bootstrap fetch path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "/openclaw/",
      assistantName: "Assistant",
      assistantAvatar: null,
      assistantAgentId: null,
      localMediaPreviewRoots: [],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
      serverVersion: null,
    };

    await loadControlUiBootstrapConfig(state);

    const fetchCall = requireFetchCall(fetchMock);
    expect(fetchCall.url).toBe(`/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`);
    expect(fetchCall.init.method).toBe("GET");

    vi.unstubAllGlobals();
  });

  it("includes the configured auth token on bootstrap fetches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "/openclaw",
      assistantName: "Assistant",
      assistantAvatar: null,
      assistantAgentId: null,
      localMediaPreviewRoots: [],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
      serverVersion: null,
      settings: { token: "session-token" },
    };

    await loadControlUiBootstrapConfig(state);

    const fetchCall = requireFetchCall(fetchMock);
    expect(fetchCall.url).toBe(`/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`);
    expect(fetchCall.init.method).toBe("GET");
    expect(fetchCall.headers.Accept).toBe("application/json");
    expect(fetchCall.headers.Authorization).toBe("Bearer session-token");

    vi.unstubAllGlobals();
  });

  it("retries with the alternate shared-secret credential when the first returns 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          basePath: "",
          assistantName: "Ops",
          assistantAvatar: null,
          assistantAgentId: null,
          serverVersion: "2026.4.22",
          localMediaPreviewRoots: [],
          embedSandbox: "scripts",
          allowExternalEmbedUrls: false,
        }),
      });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "",
      assistantName: "Assistant",
      assistantAvatar: null,
      assistantAgentId: null,
      localMediaPreviewRoots: [],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
      serverVersion: null,
      settings: { token: "stale-token" },
      password: "fresh-password",
    };

    await loadControlUiBootstrapConfig(state);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstFetchCall = requireFetchCall(fetchMock, 0);
    const secondFetchCall = requireFetchCall(fetchMock, 1);
    expect(firstFetchCall.headers.Authorization).toBe("Bearer stale-token");
    expect(secondFetchCall.headers.Authorization).toBe("Bearer fresh-password");
    expect(state.assistantName).toBe("Ops");
    expect(state.serverVersion).toBe("2026.4.22");

    vi.unstubAllGlobals();
  });

  it("stops retrying on non-auth errors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "",
      assistantName: "Assistant",
      assistantAvatar: null,
      assistantAgentId: null,
      localMediaPreviewRoots: [],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
      serverVersion: null,
      settings: { token: "a" },
      password: "b",
    };

    await loadControlUiBootstrapConfig(state);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.assistantName).toBe("Assistant");

    vi.unstubAllGlobals();
  });

  it("does not attach auth headers to protocol-relative bootstrap URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "//evil.example",
      assistantName: "Assistant",
      assistantAvatar: null,
      assistantAgentId: null,
      localMediaPreviewRoots: [],
      embedSandboxMode: "scripts" as const,
      allowExternalEmbedUrls: false,
      serverVersion: null,
      settings: { token: "session-token" },
    };

    await loadControlUiBootstrapConfig(state);

    const fetchCall = requireFetchCall(fetchMock);
    expect(fetchCall.url).toBe(`//evil.example${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`);
    expect(fetchCall.init.method).toBe("GET");
    expect(fetchCall.headers.Accept).toBe("application/json");
    expect(fetchCall.headers.Authorization).toBeUndefined();

    vi.unstubAllGlobals();
  });
});

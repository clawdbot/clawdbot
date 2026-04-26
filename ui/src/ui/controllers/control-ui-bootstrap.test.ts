/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../../src/gateway/control-ui-contract.js";
import { loadControlUiBootstrapConfig } from "./control-ui-bootstrap.ts";

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
      serverVersion: null,
    };

    await loadControlUiBootstrapConfig(state);

    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
      expect.objectContaining({ method: "GET" }),
    );
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

    expect(fetchMock).toHaveBeenCalledWith(
      CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
      expect.objectContaining({ method: "GET" }),
    );
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

    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
      expect.objectContaining({ method: "GET" }),
    );

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

    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer session-token",
        }),
      }),
    );

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
    const [, firstInit] = fetchMock.mock.calls[0] ?? [];
    const [, secondInit] = fetchMock.mock.calls[1] ?? [];
    expect((firstInit?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer stale-token",
    );
    expect((secondInit?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer fresh-password",
    );
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

    expect(fetchMock).toHaveBeenCalledWith(
      `//evil.example${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();

    vi.unstubAllGlobals();
  });
});

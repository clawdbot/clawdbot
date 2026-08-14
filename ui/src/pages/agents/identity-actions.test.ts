import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import * as avatarImage from "./avatar-image.ts";
import { resetIdentityDraft, saveIdentityDraft, selectIdentityAvatar } from "./identity-actions.ts";

const fileToAvatarDataUrlMock = vi.fn<typeof avatarImage.fileToAvatarDataUrl>();

beforeEach(() => {
  vi.spyOn(avatarImage, "fileToAvatarDataUrl").mockImplementation(fileToAvatarDataUrlMock);
});

afterEach(() => {
  fileToAvatarDataUrlMock.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function host(): Parameters<typeof resetIdentityDraft>[0] {
  return {
    identityDraft: { name: null, emoji: null, avatar: null },
    identitySaving: false,
    identityError: null,
  };
}

describe("agent identity actions", () => {
  it("keeps unsupported blank edits visible without sending an update", async () => {
    const state = host();
    state.identityDraft.name = "  ";
    const runExternalMutation = vi.fn();
    const expectedClient = { request: vi.fn() } as unknown as GatewayBrowserClient;

    await saveIdentityDraft({
      host: state,
      expectedClient,
      agentId: "main",
      agents: {} as ApplicationContext["agents"],
      agentIdentity: {} as ApplicationContext["agentIdentity"],
      runtimeConfig: {
        runExternalMutation,
      } as unknown as ApplicationContext["runtimeConfig"],
      canDispatch: () => true,
      isCurrent: () => true,
      onSaved: vi.fn(),
    });

    expect(runExternalMutation).not.toHaveBeenCalled();
    expect(state.identityDraft.name).toBe("  ");
  });

  it("drops an avatar decode that completes after the selected agent resets", async () => {
    let resolveAvatar!: (value: string | null) => void;
    fileToAvatarDataUrlMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAvatar = resolve;
      }),
    );
    const state = host();

    selectIdentityAvatar(state, {} as File);
    resetIdentityDraft(state);
    resolveAvatar("data:image/png;base64,stale");
    await Promise.resolve();

    expect(state.identityDraft.avatar).toBeNull();
  });

  it("flushes a pending config draft before agents.update and refreshes afterward", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let config: Record<string, unknown> = { pending: false };
    let hash = "hash-1";
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        order.push(method);
        return {
          config,
          sourceConfig: config,
          raw: JSON.stringify(config),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        order.push(method);
        config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { hash };
      }
      if (method === "agents.update") {
        order.push(method);
        config = { ...config, identityName: (params as { name: string }).name };
        hash = "hash-3";
        return {};
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const runtimeConfig = createRuntimeConfigCapability({
      snapshot: { client, phase: "connected", sessionKey: "main" },
      subscribe: () => () => undefined,
    });
    await runtimeConfig.ensureLoaded();
    order.length = 0;
    runtimeConfig.patchForm(["pending"], true);
    const state = host();
    state.identityDraft.name = "Agent Smith";
    const agents = {
      refreshList: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["agents"];
    const agentIdentity = {
      invalidate: vi.fn(),
      ensure: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["agentIdentity"];

    await saveIdentityDraft({
      host: state,
      expectedClient: client,
      agentId: "main",
      agents,
      agentIdentity,
      runtimeConfig,
      canDispatch: () => true,
      isCurrent: () => true,
      onSaved: vi.fn(),
    });

    expect(order).toEqual(["config.set", "agents.update", "config.get"]);
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    expect(runtimeConfig.state.configForm).toMatchObject({
      pending: true,
      identityName: "Agent Smith",
    });
    runtimeConfig.dispose();
  });

  it("does not send a stale identity draft through a replacement connection", async () => {
    const expectedClient = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const replacementRequest = vi.fn();
    const replacementClient = {
      request: replacementRequest,
    } as unknown as GatewayBrowserClient;
    const state = host();
    state.identityDraft.name = "Agent Smith";
    const runtimeConfig = {
      runExternalMutation: vi.fn(async (task) => {
        try {
          return {
            ok: true as const,
            value: await task(replacementClient),
            refresh: { ok: true as const },
          };
        } catch (error) {
          return { ok: false as const, reason: "error" as const, error: String(error) };
        }
      }),
    } as unknown as ApplicationContext["runtimeConfig"];

    await saveIdentityDraft({
      host: state,
      expectedClient,
      agentId: "main",
      agents: {} as ApplicationContext["agents"],
      agentIdentity: {} as ApplicationContext["agentIdentity"],
      runtimeConfig,
      canDispatch: () => true,
      isCurrent: () => true,
      onSaved: vi.fn(),
    });

    expect(replacementRequest).not.toHaveBeenCalled();
    expect(state.identityError).toContain(
      "Connection changed before the agent identity update started.",
    );
  });

  it("does not send a queued identity update after access changes", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const state = host();
    state.identityDraft.name = "Agent Smith";
    const runExternalMutation = vi.fn(async (_task, options) => {
      if (options?.canDispatch?.()) {
        throw new Error("Expected identity access to be revoked.");
      }
      return {
        ok: false as const,
        reason: "unavailable" as const,
        error: options?.dispatchError ?? "Access changed.",
      };
    });

    await saveIdentityDraft({
      host: state,
      expectedClient: client,
      agentId: "main",
      agents: {} as ApplicationContext["agents"],
      agentIdentity: {} as ApplicationContext["agentIdentity"],
      runtimeConfig: {
        runExternalMutation,
      } as unknown as ApplicationContext["runtimeConfig"],
      canDispatch: () => false,
      isCurrent: () => true,
      onSaved: vi.fn(),
    });

    expect(request).not.toHaveBeenCalled();
    expect(state.identityError).toContain(
      "Access changed before the agent identity update started.",
    );
  });

  it("clears a committed identity draft while surfacing a config refresh warning", async () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const state = host();
    state.identityDraft.name = "Agent Smith";
    const runExternalMutation = vi.fn(async () => ({
      ok: true as const,
      value: {},
      refresh: { ok: false as const, error: "config.get failed after identity commit" },
    }));

    await saveIdentityDraft({
      host: state,
      expectedClient: client,
      agentId: "main",
      agents: {
        refreshList: vi.fn(async () => undefined),
      } as unknown as ApplicationContext["agents"],
      agentIdentity: {
        invalidate: vi.fn(),
        ensure: vi.fn(async () => undefined),
      } as unknown as ApplicationContext["agentIdentity"],
      runtimeConfig: {
        runExternalMutation,
      } as unknown as ApplicationContext["runtimeConfig"],
      canDispatch: () => true,
      isCurrent: () => true,
      onSaved: vi.fn(),
    });

    expect(runExternalMutation).toHaveBeenCalledOnce();
    expect(state.identityDraft).toEqual({ name: null, emoji: null, avatar: null });
    expect(state.identityError).toContain("config.get failed after identity commit");
  });
});

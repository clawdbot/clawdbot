import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createRuntimeConfigCapability,
  type RuntimeConfigCapability,
} from "../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { GitHubIdentityController } from "./github-identity-controller.js";

const confirmation = vi.hoisted(() => ({ show: vi.fn(async () => true) }));
vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: confirmation.show }));

beforeEach(() => {
  confirmation.show.mockReset().mockResolvedValue(true);
});

const availableIdentity = {
  source: "agent-override",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "managed-user" },
  gitAuthor: { name: "Agent Author", email: null },
  evidence: "github-api",
  accessExpiresAtMs: 1_900_000_000_000,
  refreshState: "available",
  oauthScopes: ["repo"],
  repositoryGrants: "unknown",
} as const;

function availableStatus(scope: "system" | "agent" = "agent") {
  return {
    agentId: "main",
    selectedScope: scope,
    selected: { scope, configured: true, identity: availableIdentity },
    effective: availableIdentity,
  } as const;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createController(behavior: { beforeDispatch?: () => void; refreshError?: string } = {}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "secrets.store.set" || method === "secrets.store.delete") {
        return { ok: true };
      }
      if (method === "tools.github.configure") {
        return availableStatus((params.scope as "system" | "agent") ?? "system");
      }
      if (method === "tools.github.status") {
        return availableStatus((params.selectedScope as "system" | "agent") ?? "system");
      }
      throw new Error(`unexpected method ${method}`);
    }),
  } as unknown as GatewayBrowserClient;
  const runExternalMutation: RuntimeConfigCapability["runExternalMutation"] = async (
    task,
    mutationOptions = {},
  ) => {
    behavior.beforeDispatch?.();
    if (mutationOptions.canDispatch && !mutationOptions.canDispatch()) {
      return {
        ok: false,
        reason: "unavailable",
        error: mutationOptions.dispatchError ?? "Access changed.",
      };
    }
    try {
      return {
        ok: true,
        value: await task(client),
        refresh: behavior.refreshError ? { ok: false, error: behavior.refreshError } : { ok: true },
      };
    } catch (error) {
      return { ok: false, reason: "error", error: String(error) };
    }
  };
  const host = { requestUpdate: vi.fn(), runExternalMutation };
  return { controller: new GitHubIdentityController(host), client, requests };
}

function createStatusOnlyController(
  client: GatewayBrowserClient,
  requestUpdate = vi.fn(),
): GitHubIdentityController {
  return new GitHubIdentityController({
    requestUpdate,
    runExternalMutation: async () => ({
      ok: false,
      reason: "unavailable",
      error: "Mutation unavailable in status-only test.",
    }),
  });
}

function sync(
  controller: GitHubIdentityController,
  client: GatewayBrowserClient,
  config: Record<string, unknown> = {},
  overrides: Partial<Parameters<GitHubIdentityController["sync"]>[0]> = {},
) {
  controller.sync({
    client,
    connected: true,
    agentId: "main",
    config,
    statusReadable: true,
    configurable: true,
    authorizable: true,
    clientRevision: 1,
    ...overrides,
  });
}

describe("GitHubIdentityController", () => {
  it("keeps scope drafts isolated and clears only the inherited scope", async () => {
    const { controller, client, requests } = createController();
    sync(controller, client, {
      tools: {
        github: {
          profileId: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          gitAuthor: { name: "System Author" },
        },
      },
      agents: {
        entries: {
          main: {
            tools: {
              github: {
                profileId: "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                gitAuthor: { name: "Agent Author" },
              },
            },
          },
        },
      },
    });
    controller.setDraft("token", "agent-token");
    controller.selectScope("system");
    controller.setDraft("token", "system-token");
    controller.selectScope("agent");

    expect(controller.draft.token).toBe("agent-token");
    await controller.inherit();
    expect(confirmation.show).toHaveBeenCalled();
    expect(requests).toContainEqual({
      method: "tools.github.configure",
      params: { scope: "agent", agentId: "main", mode: "inherit" },
    });
    expect(controller.scope).toBe("agent");
    expect(controller.draft).toEqual({ token: "", name: "", email: "" });
    controller.selectScope("system");
    expect(controller.draft).toMatchObject({ name: "System Author", token: "system-token" });
  });

  it("hands off the token directly and adopts configure status without verifying again", async () => {
    const { controller, client, requests } = createController();
    sync(controller, client);
    controller.selectScope("agent");
    controller.setDraft("token", "one-use-token");
    controller.setDraft("name", "Agent Author");

    await controller.configure();

    expect(requests.map((entry) => entry.method)).toEqual([
      "secrets.store.set",
      "tools.github.configure",
    ]);
    expect(requests[0]?.params).toMatchObject({
      value: "one-use-token",
      kind: "secret",
      allowedHosts: [],
    });
    expect(requests[1]?.params).toMatchObject({
      scope: "agent",
      agentId: "main",
      mode: "managed",
      gitAuthor: { name: "Agent Author" },
    });
    expect(requests[1]?.params).not.toHaveProperty("token");
    expect(requests[1]?.params.secretName).toBe(requests[0]?.params.name);
    expect(controller.status).toEqual(availableStatus("agent"));
    expect(controller.draft.token).toBe("");
  });

  it("deletes a stored handoff when configurability changes before dispatch", async () => {
    const behavior: { beforeDispatch?: () => void } = {};
    const { controller, client, requests } = createController(behavior);
    behavior.beforeDispatch = () => sync(controller, client, {}, { configurable: false });
    sync(controller, client);
    controller.setDraft("token", "one-use-token");

    await controller.configure();

    expect(requests.map((entry) => entry.method)).toEqual([
      "secrets.store.set",
      "secrets.store.delete",
    ]);
    expect(controller.configurable).toBe(false);
    expect(controller.error).toBeNull();
  });

  it("keeps a consumed handoff successful while surfacing its refresh warning", async () => {
    const { controller, client, requests } = createController({
      refreshError: "authoritative config refresh unavailable",
    });
    sync(controller, client);
    controller.setDraft("token", "one-use-token");

    await controller.configure();

    expect(requests.map((entry) => entry.method)).toEqual([
      "secrets.store.set",
      "tools.github.configure",
    ]);
    expect(controller.status).toEqual(availableStatus("system"));
    expect(controller.draft.token).toBe("");
    expect(controller.error).toContain("GitHub identity was updated");
    expect(controller.error).toContain("authoritative config refresh unavailable");
  });

  it.each([
    { mode: "managed" as const, expectedProfileId: "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    { mode: "inherit" as const, expectedProfileId: undefined },
  ])("flushes a pending config draft before $mode and refreshes both edits", async (action) => {
    vi.useFakeTimers();
    const order: string[] = [];
    let hashCounter = 1;
    let storedConfig: Record<string, unknown> = {
      pendingEdit: "original",
      tools: { github: { profileId: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    };
    const request = vi.fn(async (method: string, params?: unknown) => {
      order.push(method);
      if (method === "config.get") {
        return {
          config: storedConfig,
          sourceConfig: storedConfig,
          raw: JSON.stringify(storedConfig),
          hash: `hash-${hashCounter}`,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        storedConfig = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hashCounter += 1;
        return { hash: `hash-${hashCounter}` };
      }
      if (method === "secrets.store.set" || method === "secrets.store.delete") {
        return { ok: true };
      }
      if (method === "tools.github.configure") {
        const configure = params as { mode: "managed" | "inherit" };
        storedConfig = {
          ...storedConfig,
          tools:
            configure.mode === "managed" ? { github: { profileId: action.expectedProfileId } } : {},
        };
        hashCounter += 1;
        return availableStatus("system");
      }
      throw new Error(`unexpected method ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const runtimeConfig = createRuntimeConfigCapability({
      snapshot: {
        client,
        phase: "connected",
        sessionKey: "main",
        hello: gatewayHelloForMethods(["config.set"]),
      },
      subscribe: () => () => undefined,
    });
    await runtimeConfig.ensureLoaded();
    order.length = 0;
    runtimeConfig.patchForm(["pendingEdit"], action.mode);
    const host = {
      requestUpdate: vi.fn(),
      runExternalMutation: runtimeConfig.runExternalMutation,
    };
    const controller = new GitHubIdentityController(host);
    sync(controller, client, runtimeConfig.state.configForm ?? {});
    const unsubscribe = runtimeConfig.subscribe(() => {
      sync(controller, client, runtimeConfig.state.configForm ?? {});
    });
    try {
      if (action.mode === "managed") {
        controller.setDraft("token", "one-use-token");
        controller.setDraft("name", "Managed Author");
        await controller.configure();
      } else {
        await controller.inherit();
      }

      expect(order).toEqual([
        ...(action.mode === "managed" ? ["secrets.store.set"] : []),
        "config.set",
        "tools.github.configure",
        "config.get",
      ]);
      expect(controller.busy).toBe(false);
      expect(controller.status).toEqual(availableStatus("system"));
      expect(controller.scope).toBe("system");
      expect(controller.draft).toEqual({
        token: "",
        name: action.mode === "managed" ? "Managed Author" : "",
        email: "",
      });
      expect(runtimeConfig.state.configForm).toMatchObject({ pendingEdit: action.mode });
      expect(
        (
          runtimeConfig.state.configForm as {
            tools?: { github?: { profileId?: string } };
          }
        ).tools?.github?.profileId,
      ).toBe(action.expectedProfileId);
    } finally {
      unsubscribe();
      runtimeConfig.dispose();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("configures in an insecure context with getRandomValues but no randomUUID", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends Uint8Array>(array: T): T => {
        array.fill(0xab);
        return array;
      },
    });
    const { controller, client, requests } = createController();
    sync(controller, client);
    controller.setDraft("token", "one-use-token");

    await controller.configure();

    expect(requests[0]?.params.name).toMatch(/^github-setup-[a-f0-9]{32}$/u);
    expect(requests[1]?.params.secretName).toBe(requests[0]?.params.name);
    expect(controller.error).toBeNull();
  });

  it("keeps UUID generation failures inside configure handling", async () => {
    vi.stubGlobal("crypto", {});
    const { controller, client, requests } = createController();
    sync(controller, client);
    controller.setDraft("token", "one-use-token");

    await expect(controller.configure()).resolves.toBeUndefined();

    expect(requests).toEqual([]);
    expect(controller.busy).toBe(false);
    expect(controller.error).toContain("Web Crypto is required");
  });

  it("sends the selected agentId for system configure actions", async () => {
    const { controller, client, requests } = createController();
    sync(controller, client);
    controller.setDraft("token", "one-use-token");
    await controller.configure();
    expect(requests[1]?.params).toMatchObject({ agentId: "main" });
  });

  it("does not dispatch without the required operator scopes", async () => {
    const { controller, client, requests } = createController();
    sync(
      controller,
      client,
      {},
      {
        statusReadable: false,
        configurable: false,
        authorizable: false,
      },
    );
    controller.setDraft("token", "unused-token");
    await controller.verify();
    await controller.configure();
    await controller.inherit();
    expect(requests).toEqual([]);
  });

  it.each([{ clientRevision: 2 }, { agentId: "reviewer" }])(
    "drops status from a stale client/agent revision %#",
    async (revisions) => {
      const host = { requestUpdate: vi.fn() };
      let resolveStatus: ((value: unknown) => void) | undefined;
      const client = {
        request: vi.fn(
          async () =>
            await new Promise((resolve) => {
              resolveStatus = resolve;
            }),
        ),
      } as unknown as GatewayBrowserClient;
      const controller = createStatusOnlyController(client, host.requestUpdate);
      sync(controller, client);
      const pending = controller.verify();
      sync(controller, client, {}, revisions);
      resolveStatus?.(availableStatus("system"));
      await pending;
      expect(controller.status).toBeNull();
      expect(controller.loading).toBe(false);
    },
  );

  it("refreshes clean drafts without overwriting active edits", () => {
    const { controller, client } = createController();
    const config = (systemName: string, agentName: string) => ({
      tools: {
        github: {
          profileId: "ghp_cccccccccccccccccccccccccccccccc",
          gitAuthor: { name: systemName },
        },
      },
      agents: {
        entries: {
          main: {
            tools: {
              github: {
                profileId: "ghp_dddddddddddddddddddddddddddddddd",
                gitAuthor: { name: agentName },
              },
            },
          },
        },
      },
    });
    sync(controller, client, config("System One", "Agent One"));
    controller.setDraft("name", "Active Agent Edit");
    sync(controller, client, config("System Two", "Agent Two"));
    expect(controller.draft.name).toBe("Active Agent Edit");
    controller.selectScope("system");
    expect(controller.draft.name).toBe("System Two");
  });

  it("invalidates selected System status when an override keeps the effective identity stable", async () => {
    const { controller, client, requests } = createController();
    const config = (systemProfileId: string) => ({
      tools: { github: { profileId: systemProfileId } },
      agents: {
        entries: {
          main: { tools: { github: { profileId: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } } },
        },
      },
    });
    sync(controller, client, config("ghp_11111111111111111111111111111111"));
    controller.selectScope("system");
    await controller.verify();
    expect(controller.status).not.toBeNull();

    sync(controller, client, config("ghp_22222222222222222222222222222222"));

    expect(controller.status).toBeNull();
    await Promise.resolve();
    expect(requests.at(-1)).toEqual({
      method: "tools.github.status",
      params: { agentId: "main", selectedScope: "system" },
    });
  });

  it("keeps the PAT fallback visible while a save is busy", () => {
    const { controller, client } = createController();
    sync(controller, client);
    controller.showPatFallback();
    controller.busy = true;

    controller.hidePatFallback();

    expect(controller.patVisible).toBe(true);
  });

  it("requires the explicit new-run disclosure before removing a selected identity", async () => {
    confirmation.show.mockResolvedValueOnce(false);
    const { controller, client, requests } = createController();
    sync(controller, client);

    await controller.inherit();

    expect(confirmation.show).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLabel: "Use native for new runs",
        message: expect.stringContaining("Active runs keep their current identity"),
      }),
    );
    expect(requests).toEqual([]);
  });

  it("invalidates an in-flight status on effective identity change and verifies once", async () => {
    const host = { requestUpdate: vi.fn() };
    const resolvers: Array<(value: ReturnType<typeof availableStatus>) => void> = [];
    const request = vi.fn(
      async () =>
        await new Promise<ReturnType<typeof availableStatus>>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = createStatusOnlyController(client, host.requestUpdate);
    const config = (profileId: string) => ({ tools: { github: { profileId } } });
    sync(controller, client, config("ghp_11111111111111111111111111111111"));
    const initial = controller.verify();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    controller.setDraft("name", "dirty author");
    sync(controller, client, config("ghp_22222222222222222222222222222222"));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(controller.draft.name).toBe("dirty author");

    resolvers[0]?.(availableStatus("system"));
    resolvers[1]?.(availableStatus("system"));
    await initial;
    await Promise.resolve();
    expect(controller.status).toEqual(availableStatus("system"));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects status returned for a different agent", async () => {
    const host = { requestUpdate: vi.fn() };
    const client = {
      request: vi.fn(async () => ({ ...availableStatus("system"), agentId: "reviewer" })),
    } as unknown as GatewayBrowserClient;
    const controller = createStatusOnlyController(client, host.requestUpdate);
    sync(controller, client);
    await controller.verify();
    expect(controller.status).toBeNull();
    expect(controller.error).toContain("different target");
  });

  it("waits for each authoritative poll deadline and adopts successful OAuth status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const pollTimes: number[] = [];
    const pollResults = [
      { status: "slow_down" as const, retryAfterMs: 10_000 },
      { status: "success" as const, githubStatus: availableStatus("system") },
    ];
    const request = vi.fn(async (method: string) => {
      if (method === "tools.github.authorize.start") {
        return {
          requestId: "github-device-11111111111111111111111111111111",
          userCode: "ABCD-1234",
          verificationUri: "https://github.com/login/device",
          expiresInMs: 60_000,
          pollAfterMs: 5_000,
        };
      }
      if (method === "tools.github.authorize.poll") {
        pollTimes.push(Date.now());
        return pollResults.shift();
      }
      throw new Error(`unexpected method ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const runExternalMutation: RuntimeConfigCapability["runExternalMutation"] = async (task) => ({
      ok: true,
      value: await task(client),
      refresh: { ok: true },
    });
    const controller = new GitHubIdentityController({
      requestUpdate: vi.fn(),
      runExternalMutation,
    });
    sync(controller, client);

    await controller.startAuthorization();
    expect(controller.authorization).toMatchObject({ phase: "code", userCode: "ABCD-1234" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(pollTimes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(pollTimes).toEqual([1_800_000_005_000]);
    expect(controller.authorization).toMatchObject({ phase: "pending", slowedDown: true });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(pollTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pollTimes).toEqual([1_800_000_005_000, 1_800_000_015_000]);
    expect(controller.status).toEqual(availableStatus("system"));
    expect(controller.authorization).toEqual({ phase: "idle" });
  });

  it.each([
    { label: "selected agent changes", overrides: { agentId: "reviewer" } },
    { label: "connection generation changes", overrides: { clientRevision: 2 } },
    { label: "administrator access is lost", overrides: { authorizable: false } },
  ])("cancels the exact authorization when $label", async ({ overrides }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const request = vi.fn(async (method: string) => {
      if (method === "tools.github.authorize.start") {
        return {
          requestId: "github-device-22222222222222222222222222222222",
          userCode: "WXYZ-9876",
          verificationUri: "https://github.com/login/device",
          expiresInMs: 60_000,
          pollAfterMs: 5_000,
        };
      }
      return { cancelled: true };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = createStatusOnlyController(client);
    sync(controller, client);
    await controller.startAuthorization();

    sync(controller, client, {}, overrides);
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("tools.github.authorize.cancel", {
      requestId: "github-device-22222222222222222222222222222222",
    });
    expect(controller.authorization).toEqual({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request.mock.calls.some(([method]) => method === "tools.github.authorize.poll")).toBe(
      false,
    );
  });

  it("locks scope during authorization and cancels the exact request on demand", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const request = vi.fn(async (method: string) =>
      method === "tools.github.authorize.start"
        ? {
            requestId: "github-device-33333333333333333333333333333333",
            userCode: "ABCD-5678",
            verificationUri: "https://github.com/login/device",
            expiresInMs: 60_000,
            pollAfterMs: 5_000,
          }
        : { cancelled: true },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = createStatusOnlyController(client);
    sync(controller, client);
    await controller.startAuthorization();

    controller.selectScope("agent");
    expect(controller.scope).toBe("system");
    const firstCancel = controller.cancelAuthorization();
    const duplicateCancel = controller.cancelAuthorization();
    await Promise.all([firstCancel, duplicateCancel]);

    expect(request).toHaveBeenCalledWith("tools.github.authorize.cancel", {
      requestId: "github-device-33333333333333333333333333333333",
    });
    expect(
      request.mock.calls.filter(([method]) => method === "tools.github.authorize.cancel"),
    ).toHaveLength(1);
    expect(controller.authorization).toEqual({ phase: "idle" });
  });

  it("keeps a too-late cancellation alive and adopts the in-flight success", async () => {
    vi.useFakeTimers();
    const poll = (() => {
      let resolve!: (value: unknown) => void;
      const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    })();
    const request = vi.fn(async (method: string) => {
      if (method === "tools.github.authorize.start") {
        return {
          requestId: "github-device-44444444444444444444444444444444",
          userCode: "LATE-0001",
          verificationUri: "https://github.com/login/device",
          expiresInMs: 60_000,
          pollAfterMs: 1_000,
        };
      }
      if (method === "tools.github.authorize.poll") {
        return await poll.promise;
      }
      if (method === "tools.github.authorize.cancel") {
        return { cancelled: false };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new GitHubIdentityController({
      requestUpdate: vi.fn(),
      runExternalMutation: async (task) => ({
        ok: true,
        value: await task(client),
        refresh: { ok: true },
      }),
    });
    sync(controller, client);
    await controller.startAuthorization();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "tools.github.authorize.poll",
        expect.anything(),
        expect.anything(),
      ),
    );

    await controller.cancelAuthorization();
    expect(controller.authorization).toMatchObject({ phase: "finishing" });
    poll.resolve({ status: "success", githubStatus: availableStatus("system") });
    await vi.waitFor(() => expect(controller.authorization).toEqual({ phase: "idle" }));

    expect(controller.status).toEqual(availableStatus("system"));
  });

  it("keeps authorization pending and surfaces a cancellation network failure", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) => {
      if (method === "tools.github.authorize.start") {
        return {
          requestId: "github-device-55555555555555555555555555555555",
          userCode: "NETW-0001",
          verificationUri: "https://github.com/login/device",
          expiresInMs: 60_000,
          pollAfterMs: 5_000,
        };
      }
      if (method === "tools.github.authorize.cancel") {
        throw new Error("Gateway unavailable");
      }
      if (method === "tools.github.authorize.poll") {
        return { status: "pending", retryAfterMs: 5_000 };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new GitHubIdentityController({
      requestUpdate: vi.fn(),
      runExternalMutation: async (task) => ({
        ok: true,
        value: await task(client),
        refresh: { ok: true },
      }),
    });
    sync(controller, client);
    await controller.startAuthorization();

    await controller.cancelAuthorization();
    expect(controller.authorization).toMatchObject({
      phase: "cancel_error",
      message: expect.stringContaining("Gateway unavailable"),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(request).toHaveBeenCalledWith(
      "tools.github.authorize.poll",
      { requestId: "github-device-55555555555555555555555555555555" },
      expect.anything(),
    );
    expect(controller.authorization).toMatchObject({ phase: "cancel_error" });
  });
});

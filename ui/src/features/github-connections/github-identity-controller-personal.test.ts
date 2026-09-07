import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PersonalGitHubStatus,
  UsersGitHubStatusResult,
  UsersGitHubAuthorizeStartResult,
} from "../../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { GitHubIdentityController } from "./github-identity-controller.ts";

const code = {
  requestId: "33333333-3333-4333-8333-333333333333",
  userCode: "SELF-1234",
  verificationUri: "https://github.com/login/device",
  expiresInMs: 60_000,
  pollAfterMs: 1_000,
} satisfies UsersGitHubAuthorizeStartResult;
const connected: PersonalGitHubStatus = {
  state: "connected",
  generation: "11111111-1111-4111-8111-111111111111",
  account: { accountId: 1234, login: "my-account" },
  accessExpiresAtMs: 1_900_000_000_000,
  refreshState: "available",
  pending: null,
};
const disconnected: PersonalGitHubStatus = {
  state: "disconnected",
  generation: null,
  account: null,
  accessExpiresAtMs: null,
  refreshState: "not_applicable",
  pending: null,
};
const system: UsersGitHubStatusResult["system"] = {
  source: "system-configured",
  credentialKind: "managed-oauth",
  credentialState: "available",
  account: { login: "system-bot" },
  gitAuthor: { name: null, email: null },
  evidence: "github-api",
  accessExpiresAtMs: null,
  refreshState: "available",
  oauthScopes: ["repo"],
  repositoryGrants: "unknown",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
function setup(respond: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn(respond);
  const client = { request } as unknown as GatewayBrowserClient;
  const runExternalMutation = vi.fn(async () => {
    throw new Error("Personal flow touched shared config");
  });
  const controller = new GitHubIdentityController({ requestUpdate: vi.fn(), runExternalMutation });
  const sync = (overrides: Partial<Parameters<GitHubIdentityController["sync"]>[0]> = {}) =>
    controller.sync({
      client,
      connected: true,
      clientRevision: 1,
      target: { kind: "personal", profileId: "profile-a" },
      statusReadable: true,
      configurable: false,
      authorizable: true,
      ...overrides,
    });
  sync();
  return { controller, request, sync, runExternalMutation };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("personal GitHub connection ownership", () => {
  it("lets an identified reader connect, reconnect and disconnect only their own OAuth account", async () => {
    vi.useFakeTimers();
    let personal = disconnected;
    const methods: string[] = [];
    const { controller, request, runExternalMutation } = setup(async (method) => {
      methods.push(method);
      if (method === "users.github.status") {
        return { personal, system };
      }
      if (method === "users.github.authorize.start") {
        return code;
      }
      if (method === "users.github.authorize.poll") {
        personal = connected;
        return { status: "success", personal };
      }
      if (method === "users.github.disconnect") {
        personal = disconnected;
        return { disconnected: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    await controller.verify();
    expect(controller.system).toEqual(system);
    expect(controller.personal).toEqual(disconnected);
    expect(controller.scope).toBe("personal");
    controller.showPatFallback();
    controller.setDraft("token", "not-a-personal-PAT");
    await controller.configure();
    await controller.inherit();
    expect(controller.patVisible).toBe(false);
    expect(controller.draft.token).toBe("");
    await controller.startAuthorization();
    expect(controller.authorization).toMatchObject({ phase: "code", userCode: code.userCode });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.personal).toEqual(connected);
    await controller.startAuthorization();
    expect(controller.personal).toEqual(connected);
    await vi.advanceTimersByTimeAsync(1_000);
    await controller.disconnect();
    expect(controller.personal).toEqual(disconnected);
    expect(controller.system).toEqual(system);
    expect(methods).toEqual([
      "users.github.status",
      "users.github.authorize.start",
      "users.github.authorize.poll",
      "users.github.authorize.start",
      "users.github.authorize.poll",
      "users.github.disconnect",
      "users.github.status",
    ]);
    expect(request).toHaveBeenCalledWith("users.github.authorize.start", {}, expect.anything());
    expect(request).toHaveBeenCalledWith(
      "users.github.authorize.poll",
      { requestId: code.requestId },
      expect.anything(),
    );
    expect(request).toHaveBeenCalledWith("users.github.disconnect", {});
    expect(runExternalMutation).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("restores only the current profile's pending code and honors server retry intervals", async () => {
    vi.useFakeTimers();
    const outcomes = [
      { status: "slow_down", retryAfterMs: 4_000 },
      { status: "network_error", retryAfterMs: 6_000 },
      { status: "success", personal: connected },
    ];
    const { controller, request, runExternalMutation } = setup(async (method) => {
      if (method === "users.github.status") {
        return { personal: { ...disconnected, pending: code }, system };
      }
      if (method === "users.github.authorize.poll") {
        return outcomes.shift();
      }
      return { cancelled: true };
    });
    await controller.verify();
    expect(controller.authorization).toMatchObject({ phase: "code", userCode: code.userCode });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.authorization).toMatchObject({ phase: "pending", slowedDown: true });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.authorization).toMatchObject({ phase: "network_error" });
    await vi.advanceTimersByTimeAsync(5_999);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.authorization).toEqual({ phase: "idle" });
    expect(controller.personal).toEqual(connected);
    expect(runExternalMutation).not.toHaveBeenCalled();
    controller.dispose();
  });

  it.each(["profile", "connection", "access", "dispose"] as const)(
    "drops delayed status and pending codes after %s changes",
    async (change) => {
      const response = deferred<UsersGitHubStatusResult>();
      const { controller, sync } = setup(async () => response.promise);
      const verification = controller.verify();
      if (change === "profile") {
        sync({ target: { kind: "personal", profileId: "profile-b" } });
      }
      if (change === "connection") {
        sync({ clientRevision: 2 });
      }
      if (change === "access") {
        sync({ statusReadable: false, authorizable: false });
      }
      if (change === "dispose") {
        controller.dispose();
      }
      response.resolve({ personal: { ...connected, pending: code }, system });
      await verification;
      expect(controller.personal).toBeNull();
      expect(controller.system).toBeNull();
      expect(controller.authorization).toEqual({ phase: "idle" });
      expect(controller.loading).toBe(false);
      controller.dispose();
    },
  );

  it.each(["start", "poll", "disconnect"] as const)(
    "invalidates an old profile's delayed %s response when another profile takes over",
    async (phase) => {
      vi.useFakeTimers();
      const response = deferred<unknown>();
      const { controller, request, sync, runExternalMutation } = setup(async (method) => {
        if (method === "users.github.status") {
          return { personal: connected, system };
        }
        if (
          method === `users.github.${phase === "disconnect" ? "disconnect" : `authorize.${phase}`}`
        ) {
          return response.promise;
        }
        if (method === "users.github.authorize.start") {
          return code;
        }
        if (method === "users.github.authorize.cancel") {
          return { cancelled: true };
        }
        throw new Error(`unexpected method ${method}`);
      });
      await controller.verify();
      const pending =
        phase === "disconnect" ? controller.disconnect() : controller.startAuthorization();
      if (phase === "poll") {
        await pending;
        await vi.advanceTimersByTimeAsync(1_000);
      }
      sync({ target: { kind: "personal", profileId: "profile-b" } });
      response.resolve(
        phase === "start"
          ? code
          : phase === "poll"
            ? { status: "success", personal: connected }
            : { disconnected: true },
      );
      await pending;
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.personal).toBeNull();
      expect(controller.authorization).toEqual({ phase: "idle" });
      expect(controller.busy).toBe(false);
      if (phase !== "disconnect") {
        expect(request).toHaveBeenCalledWith("users.github.authorize.cancel", {
          requestId: code.requestId,
        });
      }
      expect(runExternalMutation).not.toHaveBeenCalled();
      controller.dispose();
    },
  );

  it("does not expose personal authorization when durable identity is absent or status fails", async () => {
    const { controller, request, sync } = setup(async () => {
      throw new Error("Identity synchronization failed");
    });
    await controller.verify();
    expect(controller.error).toContain("Identity synchronization failed");
    expect(controller.personal).toBeNull();
    expect(controller.system).toBeNull();
    sync({ target: null, authorizable: false, statusReadable: false });
    await controller.startAuthorization();
    await controller.disconnect();
    expect(request).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

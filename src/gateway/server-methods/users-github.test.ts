import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { UsersGitHubAuthorizeStartResult } from "../../../packages/gateway-protocol/src/schema/users.js";
import {
  listGitHubDeviceAuthorizationRecords,
  listGitHubOAuthRecords,
  readGitHubDeviceAuthorizationRecord,
} from "../../agents/github-oauth-records.js";
import {
  prepareGitHubToolEnvironment,
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../../agents/github-tool-identity.js";
import { cleanupRetiredManagedGitHubProfiles } from "../../agents/github-tool-profile-cleanup.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  listSecretStoreEntries,
  readSecretStoreExecEnvironment,
  purgeExpiredSecretStoreEntries,
  writeSecretStoreEntry,
} from "../../secrets/store/secret-store.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { dumpGitBackupDatabase } from "../../snapshot/git-backup-codec.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  readUserGitHubConnection,
  resolvePersonalGitHubOwner,
} from "../../state/user-github-connections.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  getUserProfileListItem,
  linkEmail,
  setUserProfileRole,
} from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { GitHubCliUnavailableError } from "../github-cli-preflight.js";
import { createGitHubOAuthLifecycle } from "../github-oauth-lifecycle.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const network = vi.hoisted(() => ({
  assertCli: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  refresh: vi.fn(),
  verify: vi.fn<typeof import("../../agents/github-oauth-client.js").verifyGitHubCredential>(),
  command: vi.fn(),
}));
vi.mock("../../agents/github-oauth-client.js", () => ({
  clearGitHubCredentialVerificationCache: vi.fn(),
  requestGitHubOAuthDeviceCode: network.start,
  pollGitHubOAuthDeviceToken: network.poll,
  refreshGitHubOAuthToken: network.refresh,
  verifyGitHubCredential: network.verify,
}));
vi.mock("../../process/exec.js", () => ({ runCommandBuffered: network.command }));
vi.mock("../github-cli-preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-cli-preflight.js")>();
  return { ...actual, assertGitHubCliAvailable: network.assertCli };
});

const tokens = {
  accessToken: "synthetic-access",
  tokenType: "bearer" as const,
  scopes: ["gist", "read:org", "repo", "workflow"],
  expiresInSeconds: 28800,
  refreshToken: "synthetic-refresh",
  refreshTokenExpiresInSeconds: 15552000,
};
let state: OpenClawTestState;
let lifecycle: ReturnType<typeof createGitHubOAuthLifecycle>;
let config: OpenClawConfig;
let clients: Set<GatewayClient>;
let context: GatewayRequestContext;
let alice: GatewayClient;
let bob: GatewayClient;

function user(email: string, scopes = ["operator.read"]): GatewayClient {
  const profile = ensureProfileForEmail(email);
  const client: GatewayClient = {
    connId: `connection-${profile.id}`,
    authenticatedUserId: email,
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: profile.displayName,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    },
    connect: {
      role: "operator",
      scopes,
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", mode: "test", version: "1", platform: "test" },
    },
  };
  clients.add(client);
  return client;
}
function owner(client = alice): string {
  return client.authenticatedUserProfile!.profileId;
}
async function rpc(client: GatewayClient, method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: `rpc-${method}`, method, params },
    client,
    context,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}
async function start(client = alice): Promise<UsersGitHubAuthorizeStartResult> {
  const respond = await rpc(client, "users.github.authorize.start");
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]![1] as UsersGitHubAuthorizeStartResult;
}
function advance(client = alice) {
  const pending = readUserGitHubConnection(owner(client))?.pending;
  if (pending?.kind !== "device") {
    throw new Error("Expected pending device authorization");
  }
  vi.setSystemTime(pending.nextPollAtMs);
}
async function connect(client = alice) {
  const started = await start(client);
  advance(client);
  const result = await rpc(client, "users.github.authorize.poll", { requestId: started.requestId });
  expect(result.mock.calls[0]?.[1]).toMatchObject({ status: "success" });
  return readUserGitHubConnection(owner(client))!;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-20T12:00:00Z"));
  state = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
  config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
  clients = new Set();
  alice = user("alice@example.test");
  bob = user("bob@example.test");
  network.assertCli.mockReset();
  network.start.mockReset().mockResolvedValue({
    deviceCode: "d".repeat(40),
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresInSeconds: 900,
    intervalSeconds: 5,
  });
  network.poll.mockReset().mockResolvedValue({ status: "authorized", tokens });
  network.refresh.mockReset().mockResolvedValue({
    status: "refreshed",
    tokens: {
      ...tokens,
      accessToken: "synthetic-rotated-access",
      refreshToken: "synthetic-rotated-refresh",
    },
  });
  network.verify.mockReset().mockImplementation(async (token) => {
    const native = token === "synthetic-native";
    if (
      !native &&
      ![tokens.accessToken, "synthetic-rotated-access", "new-access"].includes(token)
    ) {
      return { status: "unavailable" };
    }
    return {
      status: "available",
      account: {
        accountId: native ? 303 : 101,
        login: native ? "system-bot" : "personal-alice",
        avatarUrl: null,
      },
      scopes: [],
    };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Unexpected credential HTTP request")),
  );
  network.command.mockReset().mockImplementation(async (argv: string[]) => {
    if (argv[0] === "gh" && argv.join(" ") !== "gh auth token --hostname github.com") {
      throw new Error("Unexpected GitHub CLI operation");
    }
    return {
      code: argv[0] === "git" ? 1 : 0,
      stdout: Buffer.from(argv[0] === "gh" ? "synthetic-native\n" : ""),
      stderr: Buffer.alloc(0),
    };
  });
  lifecycle = createGitHubOAuthLifecycle({
    getConfig: () => config,
    getPersistedConfig: () => config,
    warn: vi.fn(),
  });
  context = {
    getRuntimeConfig: () => config,
    githubOAuthService: lifecycle,
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(
        [...clients].filter((client) => !filter || filter(client)).map((client) => client.connId!),
      ),
    logGateway: { warn: vi.fn() },
  } as unknown as GatewayRequestContext;
});
afterEach(async () => {
  await lifecycle.stop();
  await state.cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("personal GitHub through authenticated Gateway RPC", () => {
  it.each(["native", "managed"] as const)(
    "reads personal and %s system status without selecting an agent",
    async (systemKind) => {
      const profileId = "ghp_12121212121212121212121212121212";
      config.agents = {
        entries: {
          alpha: {
            workspace: state.path("alpha-workspace"),
            tools: { github: { profileId: "ghp_34343434343434343434343434343434" } },
          },
          beta: { workspace: state.path("beta-workspace") },
        },
      };
      if (systemKind === "managed") {
        config.tools = { github: { profileId } };
        await writeManagedGitHubProfileFiles(
          resolveManagedGitHubProfileDir({ scope: "system", agentId: "", profileId }),
          { login: "system-bot", token: "synthetic-native" },
        );
      }
      await connect();
      network.verify.mockClear();
      const response = await rpc(alice, "users.github.status");
      expect(response.mock.calls[0]?.[0]).toBe(true);
      expect(response.mock.calls[0]?.[1]).toMatchObject({
        personal: { state: "connected", account: { login: "personal-alice" } },
        system: {
          source: systemKind === "managed" ? "system-configured" : "system-detected",
          credentialState: "available",
          account: { login: "system-bot" },
        },
      });
      expect(network.verify.mock.calls.map(([token]) => token)).toEqual([
        "synthetic-native",
        tokens.accessToken,
      ]);
      const gitProbes = network.command.mock.calls.filter(([argv]) => argv[0] === "git");
      expect(gitProbes).toHaveLength(1);
      expect(gitProbes[0]?.[1]?.cwd).toBe(state.stateDir);
    },
  );

  it("rejects a missing GitHub CLI before creating personal authorization state", async () => {
    network.assertCli.mockImplementationOnce(() => {
      throw new GitHubCliUnavailableError();
    });

    const response = await rpc(alice, "users.github.authorize.start");

    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(JSON.stringify(response.mock.calls)).toContain(
      "GitHub CLI (`gh`) is required on the Gateway host. Install it and retry.",
    );
    expect(network.start).not.toHaveBeenCalled();
    expect(readUserGitHubConnection(owner())).toBeUndefined();
  });

  it.each(["disconnect", "role"] as const)(
    "rechecks %s after personal status verification",
    async (race) => {
      await connect();
      const verify = network.verify.getMockImplementation()!;
      network.verify.mockImplementation(async (token, options) => {
        if (token === tokens.accessToken) {
          if (race === "disconnect") {
            await rpc(alice, "users.github.disconnect");
          } else {
            config.gateway = {
              roles: {
                definitions: { blocked: { scopes: [], agents: [], sessions: { others: "none" } } },
                default: "blocked",
              },
            };
            setUserProfileRole(owner(), "blocked");
            invalidateOperatorRolePolicy(owner());
          }
        }
        return await verify(token, options);
      });
      const response = await rpc(alice, "users.github.status");
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(response.mock.calls[0]?.[1]).toBeUndefined();
    },
  );

  it.each(["missing", "tokenless", "corrupt"])(
    "reports a %s personal profile unavailable despite native authentication",
    async (failure) => {
      const connected = await connect();
      if (connected.selection.kind !== "connected") {
        throw new Error("Expected connected profile");
      }
      const dir = resolveManagedGitHubProfileDir({
        scope: "personal",
        agentId: "",
        profileId: connected.selection.profileId,
      });
      if (failure === "missing") {
        await fs.rm(dir, { recursive: true });
      } else {
        await fs.writeFile(
          path.join(dir, "hosts.yml"),
          failure === "tokenless" ? "{}" : "github.com: [invalid",
          { mode: 0o600 },
        );
      }
      const response = await rpc(alice, "users.github.status");
      expect(response.mock.calls[0]?.[0]).toBe(true);
      expect(response.mock.calls[0]?.[1]).toMatchObject({
        personal: { state: "unavailable" },
        system: { credentialState: "available", account: { login: "system-bot" } },
      });
    },
  );

  it("preserves administrator System authorization and keeps its pending codes separate", async () => {
    alice.connect.scopes = ["operator.admin"];
    const system = await rpc(alice, "tools.github.authorize.start", {
      scope: "system",
      agentId: "main",
    });
    expect(system.mock.calls[0]?.[0]).toBe(true);
    expect(system.mock.calls[0]?.[1]).toMatchObject({
      requestId: expect.stringMatching(/^github-device-/),
    });
    expect((await rpc(alice, "users.github.status")).mock.calls[0]?.[1]).toMatchObject({
      personal: { pending: null, state: "disconnected" },
    });
  });

  it.each([
    { scope: "system", kind: "pat" },
    { scope: "agent", kind: "pat" },
    { scope: "system", kind: "oauth" },
    { scope: "agent", kind: "oauth" },
  ] as const)(
    "installs $scope $kind without mutating native GitHub authentication",
    async ({ scope, kind }) => {
      alice.connect.scopes = ["operator.admin"];
      await state.writeConfig(config);
      if (kind === "pat") {
        const secretName = "github-setup-11111111111111111111111111111111";
        writeSecretStoreEntry({
          scope: { kind: "team" },
          name: secretName,
          value: tokens.accessToken,
          kind: "secret",
          updatedBy: "test",
        });
        const response = await rpc(alice, "tools.github.configure", {
          scope,
          agentId: "main",
          mode: "managed",
          secretName,
        });
        expect(response.mock.calls[0]?.[0]).toBe(true);
        expect(response.mock.calls[0]?.[1]).toMatchObject({
          selected: { identity: { credentialKind: "managed-pat", credentialState: "available" } },
        });
      } else {
        const response = await rpc(alice, "tools.github.authorize.start", {
          scope,
          agentId: "main",
        });
        expect(response.mock.calls[0]?.[0]).toBe(true);
        const { requestId } = response.mock.calls[0]![1] as { requestId: string };
        const pending = readGitHubDeviceAuthorizationRecord(requestId);
        if (!pending) {
          throw new Error("Expected shared device authorization");
        }
        vi.setSystemTime(pending.nextPollAtMs);
        const polled = await rpc(alice, "tools.github.authorize.poll", { requestId });
        expect(polled.mock.calls[0]?.[1]).toMatchObject({ status: "success" });
      }
      config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
      const identity =
        scope === "system" ? config.tools?.github : config.agents?.entries?.main?.tools?.github;
      if (!identity) {
        throw new Error("Expected configured shared GitHub identity");
      }
      const dir = resolveManagedGitHubProfileDir({
        scope,
        agentId: "main",
        profileId: identity.profileId,
      });
      expect(parseYaml(await fs.readFile(path.join(dir, "hosts.yml"), "utf8"))).toMatchObject({
        "github.com": { user: "personal-alice", oauth_token: tokens.accessToken },
      });
      expect(network.verify.mock.calls.some(([token]) => token === tokens.accessToken)).toBe(true);
      expect(
        network.command.mock.calls.some(
          ([argv]) =>
            argv[0] === "gh" &&
            argv[1] === "auth" &&
            ["login", "logout", "switch"].includes(argv[2]),
        ),
      ).toBe(false);
      expect(
        JSON.stringify(prepareGitHubToolEnvironment({ config, agentId: "main" })),
      ).not.toContain(tokens.accessToken);
    },
  );

  it("lets an identified reader manage only My GitHub without changing sign-in or agent identity", async () => {
    const before = getUserProfileListItem(owner());
    const connection = await connect();
    const status = await rpc(alice, "users.github.status");
    expect(status.mock.calls[0]?.[1]).toMatchObject({
      personal: { state: "connected", account: { accountId: 101, login: "personal-alice" } },
      system: { source: "system-detected", account: { login: "system-bot" } },
    });
    expect(getUserProfileListItem(owner())).toEqual(before);
    expect(config.tools?.github).toBeUndefined();
    expect(prepareGitHubToolEnvironment({ config, agentId: "main" }).localIdentityEnv).toEqual({});
    expect(await rpc(alice, "users.self")).toHaveBeenCalledWith(true, { profile: before });
    for (const [method, missingScope] of [
      ["tools.github.authorize.start", "operator.admin"],
      ["tools.github.configure", "operator.admin"],
      ["secrets.store.set", "operator.admin"],
      ["sessions.github.publish", "operator.write"],
    ] as const) {
      const denied = await rpc(alice, method, {
        sessionKey: "agent:main:main",
        idempotencyKey: "reader",
      });
      expect(denied, method).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          details: {
            code: "MISSING_SCOPE",
            missingScope,
            requiredScopes: [missingScope],
          },
        }),
      );
    }
    const restarted = await start();
    expect(readUserGitHubConnection(owner())?.generation).toBe(connection.generation);
    expect(
      await rpc(alice, "users.github.authorize.cancel", { requestId: restarted.requestId }),
    ).toHaveBeenCalledWith(true, { cancelled: true });
    expect(await rpc(alice, "users.github.disconnect")).toHaveBeenCalledWith(true, {
      disconnected: true,
    });
    expect(readUserGitHubConnection(owner())?.selection.kind).toBe("disconnected");
    expect(readUserGitHubConnection(owner())?.generation).not.toBe(connection.generation);
  });

  it("preserves personal scope order and repairs corrupt state only on explicit disconnect", async () => {
    network.poll.mockResolvedValueOnce({
      status: "authorized",
      tokens: { ...tokens, scopes: ["workflow", "repo", "repo"] },
    });
    const connected = await connect();
    expect(connected.selection).toMatchObject({ scopes: ["workflow", "repo", "repo"] });
    const db = openOpenClawStateDatabase().db;
    db.prepare(
      "UPDATE secret_store_entries SET value = ? WHERE scope_kind = 'identity' AND scope_id = ? AND name = 'github-connection'",
    ).run(
      JSON.stringify({ ...connected, selection: { ...connected.selection, refreshToken: null } }),
      owner(),
    );
    expect(() => readUserGitHubConnection(owner())).toThrow("Personal GitHub state is invalid");
    await expect(lifecycle.personal.refresh(owner())).rejects.toThrow(
      "Personal GitHub state is invalid",
    );
    expect(await rpc(alice, "users.github.disconnect")).toHaveBeenCalledWith(true, {
      disconnected: true,
    });
    expect(readUserGitHubConnection(owner())?.selection).toEqual({ kind: "disconnected" });
  });

  it("rejects copied pending IDs before lookup, deduplication, or cancellation", async () => {
    const started = await start();
    advance();
    const waiting = createDeferredCore<{ status: "authorized"; tokens: typeof tokens }>();
    network.poll.mockReturnValueOnce(waiting.promise);
    const pending = rpc(alice, "users.github.authorize.poll", { requestId: started.requestId });
    await vi.waitFor(() => expect(network.poll).toHaveBeenCalledOnce());
    expect(
      await rpc(bob, "users.github.authorize.poll", { requestId: started.requestId }),
    ).toHaveBeenCalledWith(true, { status: "expired" });
    expect(
      await rpc(bob, "users.github.authorize.cancel", { requestId: started.requestId }),
    ).toHaveBeenCalledWith(true, { cancelled: false });
    expect((await rpc(bob, "users.github.status")).mock.calls[0]?.[1]).toMatchObject({
      personal: { pending: null, account: null },
    });
    waiting.resolve({ status: "authorized", tokens });
    expect((await pending).mock.calls[0]?.[1]).toMatchObject({ status: "success" });
    expect(network.poll).toHaveBeenCalledOnce();
  });

  it("lets a shared-secret owner without a login read status and start My GitHub authorization", async () => {
    const profile = ensureGatewayOwnerProfile("Gateway Owner");
    delete alice.authenticatedUserId;
    alice.authenticatedUserProfile = {
      profileId: profile.id,
      displayName: profile.displayName,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    };
    alice.internal = { operatorRoleActor: { kind: "system" } };

    expect(await rpc(alice, "users.github.status")).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ personal: expect.objectContaining({ state: "disconnected" }) }),
    );
    const started = await start(alice);
    expect(readUserGitHubConnection(profile.id)?.pending?.requestId).toBe(started.requestId);
  });

  it.each([
    "unbound",
    "synthetic",
    "synthetic-system",
    "copied-client",
    "system-without-profile",
    "operator-actor",
  ] as const)("rejects %s profile-like authorization", async (mode) => {
    let client = alice;
    if (mode === "unbound") {
      delete client.authenticatedUserProfile;
    }
    if (mode === "synthetic") {
      client.internal = { syntheticClient: true };
    }
    if (mode === "synthetic-system") {
      client.internal = { syntheticClient: true, operatorRoleActor: { kind: "system" } };
    }
    if (mode === "operator-actor") {
      client.internal = { operatorRoleActor: { kind: "operator", profileId: owner(client) } };
    }
    if (mode === "copied-client") {
      client = { ...client };
    }
    if (mode === "system-without-profile") {
      delete client.authenticatedUserId;
      delete client.authenticatedUserProfile;
      client.internal = { operatorRoleActor: { kind: "system" } };
    }
    for (const method of [
      "users.github.status",
      "users.github.authorize.start",
      "users.github.disconnect",
    ]) {
      expect((await rpc(client, method)).mock.calls[0]?.[0]).toBe(false);
    }
    expect(network.start).not.toHaveBeenCalled();
  });

  it.each(["cancel", "disconnect", "replacement", "merge", "role", "expiry"] as const)(
    "fences installation when %s wins the awaited poll",
    async (race) => {
      const started = await start();
      advance();
      const waiting = createDeferredCore<{ status: "authorized"; tokens: typeof tokens }>();
      network.poll.mockReturnValueOnce(waiting.promise);
      const pending = rpc(alice, "users.github.authorize.poll", { requestId: started.requestId });
      await vi.waitFor(() => expect(network.poll).toHaveBeenCalledOnce());
      if (race === "cancel") {
        await rpc(alice, "users.github.authorize.cancel", { requestId: started.requestId });
      }
      if (race === "disconnect") {
        await rpc(alice, "users.github.disconnect");
      }
      if (race === "replacement") {
        await start();
      }
      if (race === "merge") {
        linkEmail("alice@example.test", owner(bob));
      }
      if (race === "role") {
        config.gateway = {
          roles: {
            definitions: { blocked: { scopes: [], agents: [], sessions: { others: "none" } } },
            default: "blocked",
          },
        };
        setUserProfileRole(owner(), "blocked");
        invalidateOperatorRolePolicy(owner());
      }
      if (race === "expiry") {
        vi.setSystemTime(Date.now() + 900000);
      }
      waiting.resolve({ status: "authorized", tokens });
      const response = await pending;
      expect(response.mock.calls[0]?.[1]).not.toMatchObject({ status: "success" });
      expect(readUserGitHubConnection(resolvePersonalGitHubOwner(owner())!)?.selection.kind).toBe(
        "disconnected",
      );
      expect(network.command.mock.calls.some(([argv]) => argv[1] === "auth")).toBe(false);
    },
  );

  it("does not let an older start overwrite a newer start or disconnected generation", async () => {
    const old = createDeferredCore<Awaited<ReturnType<typeof network.start>>>();
    network.start.mockReturnValueOnce(old.promise);
    const pending = rpc(alice, "users.github.authorize.start");
    await vi.waitFor(() => expect(network.start).toHaveBeenCalledOnce());
    await rpc(alice, "users.github.disconnect");
    const newer = await start();
    old.resolve({
      deviceCode: "e".repeat(40),
      userCode: "EFGH-5678",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    });
    expect((await pending).mock.calls[0]?.[0]).toBe(false);
    expect(readUserGitHubConnection(owner())?.pending?.requestId).toBe(newer.requestId);
  });

  it.each(["cancel", "disconnect", "expiry"] as const)(
    "rechecks %s after credential verification before the final connection commit",
    async (race) => {
      const started = await start();
      advance();
      const fallback = network.verify.getMockImplementation()!;
      network.verify.mockImplementation(async (token, options) => {
        const result = await fallback(token, options);
        if (token === tokens.accessToken) {
          if (race === "cancel") {
            await rpc(alice, "users.github.authorize.cancel", { requestId: started.requestId });
          }
          if (race === "disconnect") {
            await rpc(alice, "users.github.disconnect");
          }
          if (race === "expiry") {
            vi.setSystemTime(Date.now() + 900000);
          }
        }
        return result;
      });
      expect(
        (await rpc(alice, "users.github.authorize.poll", { requestId: started.requestId })).mock
          .calls[0]?.[1],
      ).not.toMatchObject({ status: "success" });
      expect(readUserGitHubConnection(owner())?.selection.kind).toBe("disconnected");
    },
  );

  it.each(["absent", "disconnected", "connected"] as const)(
    "merges credentials only when the target is %s, cancels pending flows, and rotates authority",
    async (target) => {
      const source = await connect();
      if (target === "disconnected") {
        await rpc(bob, "users.github.disconnect");
      }
      if (target === "connected") {
        await connect(bob);
      }
      const previousTarget = readUserGitHubConnection(owner(bob));
      await start();
      linkEmail("alice@example.test", owner(bob));
      const merged = readUserGitHubConnection(owner(bob));
      expect(merged?.selection).toEqual((previousTarget ?? source).selection);
      expect(merged?.pending).toBeUndefined();
      expect(merged?.generation).not.toBe(source.generation);
      expect(merged?.generation).not.toBe(previousTarget?.generation);
    },
  );

  it.each(["source", "target", "both", "source-with-absent-target"] as const)(
    "isolates corrupt %s GitHub state from canonical profile merging",
    async (corrupt) => {
      await connect();
      const target = corrupt === "source-with-absent-target" ? undefined : await connect(bob);
      const db = openOpenClawStateDatabase().db;
      for (const client of corrupt === "both"
        ? [alice, bob]
        : [corrupt.startsWith("source") ? alice : bob]) {
        db.prepare(
          "UPDATE secret_store_entries SET value = ? WHERE scope_kind = 'identity' AND scope_id = ? AND name = 'github-connection'",
        ).run("{invalid-personal-json", owner(client));
      }
      expect(() => linkEmail("alice@example.test", owner(bob))).not.toThrow();
      expect(resolvePersonalGitHubOwner(owner())).toBe(owner(bob));
      const merged = readUserGitHubConnection(owner(bob));
      expect(merged?.selection).toEqual(
        corrupt === "source" ? target!.selection : { kind: "disconnected" },
      );
      expect(merged?.generation).not.toBe(target?.generation);
      expect(merged?.pending).toBeUndefined();
      expect((await rpc(bob, "users.github.authorize.start")).mock.calls[0]?.[0]).toBe(true);
    },
  );

  it("rolls back the profile merge on a real database failure instead of classifying it as corrupt credentials", async () => {
    const before = await connect();
    const db = openOpenClawStateDatabase().db;
    db.exec(`CREATE TEMP TRIGGER reject_personal_merge BEFORE INSERT ON secret_store_entries
      BEGIN SELECT RAISE(ABORT, 'synthetic merge storage failure'); END`);
    expect(() => linkEmail("alice@example.test", owner(bob))).toThrow(
      "synthetic merge storage failure",
    );
    db.exec("DROP TRIGGER reject_personal_merge");
    expect(resolvePersonalGitHubOwner(owner())).toBe(owner());
    expect(readUserGitHubConnection(owner())).toEqual(before);
    expect(readUserGitHubConnection(owner(bob))).toBeUndefined();
  });

  it("does not adopt credentials stranded on an alias by an older profile merge", async () => {
    await connect();
    openOpenClawStateDatabase()
      .db.prepare("UPDATE user_profiles SET merged_into = ? WHERE id = ?")
      .run(owner(bob), owner());
    expect((await rpc(alice, "users.github.status")).mock.calls[0]?.[1]).toMatchObject({
      personal: { state: "disconnected", account: null },
    });
    await lifecycle.personal.maintain();
    expect(readUserGitHubConnection(owner(bob))).toBeUndefined();
    openOpenClawStateDatabase()
      .db.prepare("DELETE FROM user_profiles WHERE id = ?")
      .run(owner(bob));
    expect((await rpc(alice, "users.github.authorize.start")).mock.calls[0]?.[0]).toBe(false);
  });

  it("keeps private credentials outside generic store access, exec projection, backups, and shared cleanup", async () => {
    const connected = await connect();
    if (connected.selection.kind !== "connected") {
      throw new Error("Expected connection");
    }
    const dir = resolveManagedGitHubProfileDir({
      agentId: "",
      scope: "personal",
      profileId: connected.selection.profileId,
    });
    expect(dir).toContain(path.join("credentials", "github", "personal"));
    expect((await fs.stat(dir)).mode & 0o077).toBe(0);
    expect(listSecretStoreEntries({ scope: { kind: "team" } })).toEqual([]);
    expect(readSecretStoreExecEnvironment({ includeSecretSentinels: true })).toEqual({});
    expect(listGitHubOAuthRecords()).toEqual([]);
    expect(listGitHubDeviceAuthorizationRecords()).toEqual([]);
    purgeExpiredSecretStoreEntries();
    await cleanupRetiredManagedGitHubProfiles({ config });
    expect(await fs.readFile(path.join(dir, "hosts.yml"), "utf8")).toContain(tokens.accessToken);
    const database = openOpenClawStateDatabase();
    const manifest = await dumpGitBackupDatabase({
      snapshotPath: database.path,
      outputPath: state.path("redacted-backup"),
      identity: { role: "global" },
      excludeSecrets: true,
    });
    expect(manifest.excludedTables).toContain("secret_store_entries");
    const status = (await rpc(alice, "users.github.status")).mock.calls[0]?.[1];
    expect(JSON.stringify(status)).not.toMatch(
      /synthetic-access|synthetic-refresh|ghp_|credentials/,
    );
  });

  it("preserves rotated tokens across merge and local materialization failure without preserving old action authority", async () => {
    const connection = await connect();
    if (connection.selection.kind !== "connected") {
      throw new Error("Expected connection");
    }
    vi.setSystemTime(connection.selection.accessExpiresAtMs - 1);
    const refresh = createDeferredCore<{ status: "refreshed"; tokens: typeof tokens }>();
    network.refresh.mockReturnValueOnce(refresh.promise);
    const pending = lifecycle.personal.refresh(owner());
    await vi.waitFor(() => expect(network.refresh).toHaveBeenCalledOnce());
    linkEmail("alice@example.test", owner(bob));
    network.verify.mockResolvedValueOnce({ status: "unverified" });
    refresh.resolve({
      status: "refreshed",
      tokens: { ...tokens, accessToken: "new-access", refreshToken: "new-refresh" },
    });
    await expect(pending).rejects.toThrow();
    expect(readUserGitHubConnection(owner(bob))?.selection).toMatchObject({
      profileId: connection.selection.profileId,
      refreshToken: "new-refresh",
      refresh: { tokens: { accessToken: "new-access" } },
    });
    expect(readUserGitHubConnection(owner(bob))?.generation).not.toBe(connection.generation);
    await lifecycle.personal.refresh(owner(bob));
    expect(readUserGitHubConnection(owner(bob))?.selection).toMatchObject({
      refreshToken: "new-refresh",
    });
    expect(readUserGitHubConnection(owner(bob))?.selection).not.toHaveProperty("refresh");
    expect(network.refresh).toHaveBeenCalledOnce();
  });

  it("does not resurrect a disconnected selection from a late remote refresh", async () => {
    const connection = await connect();
    if (connection.selection.kind !== "connected") {
      throw new Error("Expected connection");
    }
    vi.setSystemTime(connection.selection.accessExpiresAtMs - 1);
    const refresh = createDeferredCore<{ status: "refreshed"; tokens: typeof tokens }>();
    network.refresh.mockReturnValueOnce(refresh.promise);
    const pending = lifecycle.personal.refresh(owner());
    await vi.waitFor(() => expect(network.refresh).toHaveBeenCalledOnce());
    await rpc(alice, "users.github.disconnect");
    const generation = readUserGitHubConnection(owner())?.generation;
    refresh.resolve({ status: "refreshed", tokens });
    await pending;
    await lifecycle.personal.maintain();
    expect(readUserGitHubConnection(owner())).toMatchObject({
      generation,
      selection: { kind: "disconnected" },
    });
  });

  it.each([false, true])(
    "recovers an exact remote rotation after persistence failure, disconnected=%s",
    async (disconnect) => {
      const connection = await connect();
      if (connection.selection.kind !== "connected") {
        throw new Error("Expected connection");
      }
      vi.setSystemTime(connection.selection.accessExpiresAtMs - 1);
      const db = openOpenClawStateDatabase().db;
      db.exec(
        "CREATE TEMP TRIGGER reject_rotation BEFORE UPDATE ON secret_store_entries WHEN NEW.value LIKE '%synthetic-rotated-refresh%' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END",
      );
      await expect(lifecycle.personal.refresh(owner())).rejects.toThrow("synthetic write failure");
      db.exec("DROP TRIGGER reject_rotation");
      if (disconnect) {
        await rpc(alice, "users.github.disconnect");
      }
      await lifecycle.personal.maintain();
      expect(network.refresh).toHaveBeenCalledOnce();
      expect(readUserGitHubConnection(owner())?.selection).toMatchObject(
        disconnect
          ? { kind: "disconnected" }
          : { kind: "connected", refreshToken: "synthetic-rotated-refresh" },
      );
    },
  );

  it("drains a remotely rotated refresh during shutdown and reopens the exact durable connection", async () => {
    const connection = await connect();
    if (connection.selection.kind !== "connected") {
      throw new Error("Expected connection");
    }
    vi.setSystemTime(connection.selection.accessExpiresAtMs - 1);
    const refreshed = createDeferredCore<{ status: "refreshed"; tokens: typeof tokens }>();
    network.refresh.mockReturnValueOnce(refreshed.promise);
    const pending = lifecycle.personal.refresh(owner());
    await vi.waitFor(() => expect(network.refresh).toHaveBeenCalledOnce());
    const stop = lifecycle.stop();
    expect(network.refresh.mock.calls[0]?.[0]).not.toHaveProperty("signal");
    refreshed.resolve({
      status: "refreshed",
      tokens: { ...tokens, refreshToken: "shutdown-rotated" },
    });
    await pending;
    await stop;
    expect(readUserGitHubConnection(owner())).toMatchObject({
      generation: connection.generation,
      selection: { refreshToken: "shutdown-rotated" },
    });
  });
});

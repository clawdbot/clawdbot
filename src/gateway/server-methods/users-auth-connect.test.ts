import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  UsersAuthConnectStartResult,
  UsersAuthConnectStatusResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import type { AuthProfileCredential, OAuthCredential } from "../../agents/auth-profiles/types.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthResult,
} from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { UserProfileAuthLink } from "../../state/user-model-accounts.js";
import { createModelAccountConnectService } from "../model-account-connect.js";
import { broadcastChatMetadataChanged } from "../server-chat-metadata-lifecycle.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { usersHandlers } from "./users.js";

const getUserProfileListItem = vi.hoisted(() => vi.fn());
const resolveUserProfileId = vi.hoisted(() => vi.fn());
const ensureProfileForEmail = vi.hoisted(() => vi.fn());
const connectUserModelAccount = vi.hoisted(() => vi.fn());
const listUserProfileAuthLinks = vi.hoisted(() => vi.fn());
const listUserModelAccounts = vi.hoisted(() => vi.fn());
const readUserModelAccountSummary = vi.hoisted(() => vi.fn());
const setUserProfileAuthLink = vi.hoisted(() => vi.fn());
const clearUserProfileAuthLink = vi.hoisted(() => vi.fn());
const ensureAuthProfileStoreWithoutExternalProfiles = vi.hoisted(() => vi.fn());
const registerSecretValueForRedaction = vi.hoisted(() => vi.fn());
const listPersonalAccountAuthChoices = vi.hoisted(() => vi.fn());
const resolvePersonalAccountAuthMethod = vi.hoisted(() => vi.fn());
const exchange = vi.hoisted(() => vi.fn());

vi.mock("../../state/user-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/user-profiles.js")>();
  return {
    ...actual,
    ensureProfileForEmail,
    getUserProfileListItem,
    resolveUserProfileId,
    getUserProfileRole: () => null,
  };
});
vi.mock("../../state/user-model-accounts.js", () => ({
  connectUserModelAccount,
  listUserProfileAuthLinks,
  listUserModelAccounts,
  readUserModelAccountSummary,
  setUserProfileAuthLink,
  clearUserProfileAuthLink,
}));
vi.mock("../../agents/auth-profiles/shared-main-dir.js", () => ({
  resolveSharedMainAuthAgentDir: () => "/tmp/shared-main-agent",
}));
vi.mock("../../agents/auth-profiles/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/auth-profiles/store.js")>()),
  ensureAuthProfileStoreWithoutExternalProfiles,
}));
vi.mock("../../logging/secret-redaction-registry.js", () => ({ registerSecretValueForRedaction }));
vi.mock("../../plugins/personal-account-auth.js", () => ({
  listPersonalAccountAuthChoices,
  resolvePersonalAccountAuthMethod,
}));

type TestClient = GatewayClient & { connId: string; invalidated: boolean };
type ConnectTestContext = Pick<
  GatewayRequestContext,
  | "broadcast"
  | "logGateway"
  | "modelAccountConnectService"
  | "getRuntimeConfig"
  | "getClientConnIds"
>;
const credential: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  accountId: "workspace-1",
  expires: 123,
};
const authorized: ProviderAuthResult = {
  profiles: [{ profileId: "openai:ignored-shared-id", credential }],
};
const runAuth = vi.fn(async (ctx: ProviderAuthContext) => {
  const value = await ctx.prompter.text({
    message: "Provider credential",
    sensitive: true,
    validate: (answer) => (answer === "synthetic-code" ? undefined : `Invalid: ${answer}`),
  });
  return exchange(value, ctx.signal);
});
const oauthMethod: ProviderAuthMethod = {
  id: "oauth",
  label: "Browser sign-in",
  kind: "oauth",
  run: runAuth,
};
const broadcast = vi.fn();
const warn = vi.fn();
let service: ReturnType<typeof createModelAccountConnectService>;
let context: ConnectTestContext;
let config: OpenClawConfig;
let clients: Set<TestClient>;
let self: TestClient;
let writes: AuthProfileCredential[];
let linksByOwner: Map<string, UserProfileAuthLink[]>;

function createClient(profileId = "profile-1", scopes = ["operator.write"]): TestClient {
  const client: TestClient = {
    connId: `connection-${clients.size + 1}`,
    invalidated: false,
    authenticatedUserProfile: { profileId, displayName: "Ada", hasAvatar: false, updatedAt: 1 },
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

async function rpc(
  requestMethod: string,
  params: Record<string, unknown>,
  client: TestClient = self,
) {
  const respond = vi.fn();
  await expectDefined(
    usersHandlers[requestMethod],
    `${requestMethod} test invariant`,
  )({
    req: { type: "req", id: "connect-test", method: requestMethod, params },
    client,
    context: context as GatewayRequestContext,
    params,
    respond,
    isWebchatConnect: () => false,
  });
  return respond;
}
async function startFlow(
  profileId = "profile-1",
  client = self,
  provider = "openai",
): Promise<UsersAuthConnectStartResult> {
  const respond = await rpc(
    "users.authConnect.start",
    { profileId, provider, method: "oauth" },
    client,
  );
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ connectId: expect.any(String) }),
  );
  const flow = respond.mock.calls[0]?.[1] as UsersAuthConnectStartResult;
  await vi.waitFor(async () =>
    expect(await status(flow, profileId, client)).toMatchObject({
      status: "pending",
      step: { type: "text" },
    }),
  );
  return flow;
}
async function complete(flow: UsersAuthConnectStartResult, profileId = "profile-1", client = self) {
  const current: UsersAuthConnectStatusResult = await status(flow, profileId, client);
  return rpc(
    "users.authConnect.answer",
    {
      profileId,
      connectId: flow.connectId,
      stepId: current.status === "pending" ? current.step!.id : "retired-step",
      value: "synthetic-code",
    },
    client,
  );
}
async function terminal(
  flow: UsersAuthConnectStartResult,
  expected: string,
  profileId = "profile-1",
  client = self,
) {
  await vi.waitFor(async () =>
    expect(await status(flow, profileId, client)).toMatchObject({ status: expected }),
  );
  return status(flow, profileId, client);
}
async function status(flow: UsersAuthConnectStartResult, profileId = "profile-1", client = self) {
  const respond = await rpc(
    "users.authConnect.status",
    { profileId, connectId: flow.connectId },
    client,
  );
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]?.[1];
}

beforeEach(async () => {
  vi.clearAllMocks();
  broadcast.mockReset();
  config = {};
  clients = new Set();
  self = createClient();
  writes = [];
  linksByOwner = new Map();
  listUserProfileAuthLinks.mockImplementation((owner: string) => linksByOwner.get(owner) ?? []);
  listUserModelAccounts.mockReset().mockReturnValue({ accounts: [] });
  readUserModelAccountSummary.mockReset();
  ensureAuthProfileStoreWithoutExternalProfiles
    .mockReset()
    .mockReturnValue({ version: 1, profiles: { "openai:shared": credential } });
  clearUserProfileAuthLink
    .mockReset()
    .mockImplementation(
      (params: { profileId: string; provider: string; assertCurrent?: () => void }) => {
        params.assertCurrent?.();
        const links = (linksByOwner.get(params.profileId) ?? []).filter(
          (link) => link.provider !== params.provider,
        );
        linksByOwner.set(params.profileId, links);
        return links;
      },
    );
  setUserProfileAuthLink
    .mockReset()
    .mockImplementation(
      (params: {
        profileId: string;
        provider: string;
        authProfileId: string;
        assertCurrent?: () => void;
      }) => {
        params.assertCurrent?.();
        const links = [
          { provider: params.provider, authProfileId: params.authProfileId, updatedAt: 2 },
        ];
        linksByOwner.set(params.profileId, links);
        return links;
      },
    );
  getUserProfileListItem.mockImplementation((id: string) => ({
    id,
    displayName: "Ada",
    emails: [],
  }));
  resolveUserProfileId.mockImplementation((id: string) => id);
  ensureProfileForEmail.mockReturnValue({ id: "profile-1" });
  listPersonalAccountAuthChoices.mockReturnValue([
    {
      pluginId: "openai",
      providerId: "openai",
      methodId: "oauth",
      choiceLabel: "Browser sign-in",
      groupLabel: "OpenAI",
    },
  ]);
  resolvePersonalAccountAuthMethod.mockReturnValue(oauthMethod);
  exchange.mockResolvedValue(authorized);
  connectUserModelAccount.mockImplementation(
    (params: {
      ownerProfileId: string;
      credential: AuthProfileCredential;
      assertCurrent: () => void;
    }) => {
      params.assertCurrent();
      writes.push(params.credential);
      const authProfileId = `personal:${params.ownerProfileId}:account-1`;
      const links = [
        ...(linksByOwner.get(params.ownerProfileId) ?? []).filter(
          (link) => link.provider !== params.credential.provider,
        ),
        { provider: params.credential.provider, authProfileId, updatedAt: 1 },
      ];
      linksByOwner.set(params.ownerProfileId, links);
      return { authProfileId, links };
    },
  );
  service = createModelAccountConnectService({
    getConfig: () => config,
    onChanged: () => broadcastChatMetadataChanged(context),
  });
  context = {
    broadcast,
    logGateway: { ...createSubsystemLogger("gateway"), warn },
    modelAccountConnectService: service,
    getRuntimeConfig: () => config,
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(
        [...clients]
          .filter((client) => !client.invalidated && (!filter || filter(client)))
          .map((client) => client.connId),
      ),
  };
});
afterEach(async () => {
  await service.stop();
  vi.restoreAllMocks();
});

describe("users model-account connection lifecycle", () => {
  it("lists account pages for their owner or an identified administrator", async () => {
    const accounts = [
      {
        authProfileId: "personal:profile-1:saved",
        provider: "openai",
        label: "Saved account",
        authType: "oauth",
        selected: false,
      },
    ];
    listUserModelAccounts.mockReturnValue({ accounts, nextCursor: "personal:profile-1:saved" });
    expect(
      await rpc("users.listModelAccounts", { cursor: "personal:profile-1:before" }),
    ).toHaveBeenCalledWith(true, {
      profileId: "profile-1",
      accounts,
      nextCursor: "personal:profile-1:saved",
      links: [],
    });
    expect(listUserModelAccounts).toHaveBeenCalledWith({
      profileId: "profile-1",
      cursor: "personal:profile-1:before",
    });
    expect(await rpc("users.listAuthLinks", { profileId: "profile-1" })).toHaveBeenCalledWith(
      true,
      { links: [] },
    );
    listUserModelAccounts.mockClear();
    listUserProfileAuthLinks.mockClear();
    expect(
      await rpc("users.listModelAccounts", { profileId: "profile-other" }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
    expect(listUserModelAccounts).not.toHaveBeenCalled();
    expect(await rpc("users.listAuthLinks", { profileId: "profile-other" })).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(listUserProfileAuthLinks).not.toHaveBeenCalled();

    const admin = createClient("profile-admin", ["operator.admin"]);
    listUserModelAccounts.mockReturnValue({ accounts: [] });
    expect(
      await rpc("users.listModelAccounts", { profileId: "profile-other" }, admin),
    ).toHaveBeenCalledWith(true, {
      profileId: "profile-other",
      accounts: [],
      links: [],
    });
    expect(listUserModelAccounts).toHaveBeenCalledWith({
      profileId: "profile-other",
      cursor: undefined,
    });
  });

  it.each([
    ["users.listModelAccounts", {}],
    ["users.authConnect.catalog", {}],
    ["users.authConnect.start", { provider: "openai", method: "oauth" }],
    ["users.selectModelAccount", { authProfileId: "personal:profile-other:saved" }],
    ["users.listAuthLinks", {}],
    ["users.linkAuthProfile", { authProfileId: "openai:shared" }],
    ["users.unlinkAuthProfile", { provider: "openai" }],
  ] as const)(
    "requires an identified administrator for %s with an explicit owner",
    async (method, params) => {
      delete self.authenticatedUserProfile;
      self.connect.scopes = ["operator.admin"];
      readUserModelAccountSummary.mockReturnValue({
        provider: "openai",
        authProfileId: "personal:profile-other:saved",
      });

      expect(await rpc(method, { ...params, profileId: "profile-other" })).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(getUserProfileListItem).not.toHaveBeenCalled();
      expect(runAuth).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
      expect(linksByOwner.size).toBe(0);
    },
  );

  it("selects a retained owned account and cancels an older sign-in without rewriting credentials", async () => {
    const flow = await startFlow();
    expect(
      await rpc("users.selectModelAccount", { authProfileId: "personal:profile-other:missing" }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(await status(flow)).toMatchObject({ status: "pending" });
    readUserModelAccountSummary.mockReturnValue({
      provider: "openai",
      authProfileId: "personal:profile-1:saved",
    });
    expect(
      await rpc("users.selectModelAccount", { authProfileId: "personal:profile-1:saved" }),
    ).toHaveBeenCalledWith(true, {
      links: [{ provider: "openai", authProfileId: "personal:profile-1:saved", updatedAt: 2 }],
    });
    expect(readUserModelAccountSummary).toHaveBeenCalledWith({
      profileId: "profile-1",
      authProfileId: "personal:profile-1:saved",
    });
    expect(await status(flow)).toEqual({ status: "cancelled" });
    expect(await complete(flow)).toHaveBeenCalledWith(true, { status: "cancelled" });
    expect(writes).toEqual([]);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "chat.metadata.changed",
      {},
      { dropIfSlow: true },
    );
    expect(
      await rpc("users.unlinkAuthProfile", { profileId: "profile-1", provider: "openai" }),
    ).toHaveBeenCalledWith(true, { links: [] });
    expect(linksByOwner.get("profile-1")).toEqual([]);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it.each([
    "disconnected",
    "agent caller",
    "synthetic system actor",
    "delegated operator actor",
    "system actor without a profile",
    "copied client",
    "agent tool caller",
  ] as const)(
    "refuses account links and selection for %s without changing the default",
    async (reason) => {
      const flow = await startFlow();
      const links = [{ provider: "openai", authProfileId: "openai:saved", updatedAt: 1 }];
      linksByOwner.set("profile-1", links);
      const admin = createClient("profile-admin", ["operator.admin"]);
      let caller = admin;
      if (reason === "disconnected") {
        clients.delete(admin);
      } else if (reason === "agent caller") {
        admin.internal = { syntheticClient: true };
      } else if (reason === "synthetic system actor") {
        admin.internal = { syntheticClient: true, operatorRoleActor: { kind: "system" } };
      } else if (reason === "delegated operator actor") {
        admin.internal = { operatorRoleActor: { kind: "operator", profileId: "profile-admin" } };
      } else if (reason === "system actor without a profile") {
        delete admin.authenticatedUserProfile;
        admin.internal = { operatorRoleActor: { kind: "system" } };
      } else if (reason === "copied client") {
        caller = { ...admin };
      } else if (reason === "agent tool caller") {
        admin.internal = { agentToolCaller: { agentId: "main", sessionKey: "agent:main:test" } };
      }
      const results = [];
      for (const [method, params] of [
        ["users.selectModelAccount", { authProfileId: "personal:profile-1:saved" }],
        ["users.listAuthLinks", {}],
        ["users.linkAuthProfile", { authProfileId: "openai:shared" }],
        ["users.unlinkAuthProfile", { provider: "openai" }],
      ] as const) {
        results.push((await rpc(method, { ...params, profileId: "profile-1" }, caller)).mock.calls);
      }
      expect(results).toEqual(
        Array.from({ length: 4 }, () => [
          [false, undefined, expect.objectContaining({ code: "FORBIDDEN" })],
        ]),
      );
      expect(linksByOwner.get("profile-1")).toEqual(links);
      expect(await status(flow)).toMatchObject({ status: "pending" });
      expect(setUserProfileAuthLink).not.toHaveBeenCalled();
      expect(clearUserProfileAuthLink).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    },
  );

  it.each(["shared", "personal", "config-declared"] as const)(
    "lets an identified administrator attach a %s credential and retire the old sign-in",
    async (source) => {
      const owner = randomUUID();
      const admin = createClient("profile-admin", ["operator.admin"]);
      const provider = source === "config-declared" ? "amazon-bedrock" : "openai";
      const authProfileId =
        source === "personal" ? `personal:${owner}:${randomUUID()}` : `${provider}:shared`;
      if (source === "config-declared") {
        ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({ version: 1, profiles: {} });
        config = { auth: { profiles: { [authProfileId]: { provider, mode: "aws-sdk" } } } };
      }
      const flow = await startFlow(owner, admin, provider);
      readUserModelAccountSummary.mockReturnValue({ provider, authProfileId });
      expect(
        await rpc("users.linkAuthProfile", { profileId: owner, authProfileId }, admin),
      ).toHaveBeenCalledWith(true, {
        links: [{ provider, authProfileId, updatedAt: 2 }],
      });
      expect(await status(flow, owner, admin)).toEqual({ status: "cancelled" });
      expect(await rpc("users.listAuthLinks", { profileId: owner }, admin)).toHaveBeenCalledWith(
        true,
        { links: linksByOwner.get(owner) },
      );
      expect(
        await rpc("users.unlinkAuthProfile", { profileId: owner, provider }, admin),
      ).toHaveBeenCalledWith(true, { links: [] });
      expect(linksByOwner.get(owner)).toEqual([]);
      expect(broadcast).toHaveBeenCalledTimes(2);
      expect(writes).toEqual([]);
      if (source === "personal") {
        expect(readUserModelAccountSummary).toHaveBeenCalledWith({
          profileId: owner,
          authProfileId,
        });
        expect(ensureAuthProfileStoreWithoutExternalProfiles).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps failed manual attachments from changing a default or cancelling its sign-in", async () => {
    const flow = await startFlow();
    const params = { profileId: "profile-1", authProfileId: "openai:shared" };
    expect(await rpc("users.linkAuthProfile", params)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    const admin = createClient("profile-admin", ["operator.admin"]);
    expect(
      await rpc("users.linkAuthProfile", { ...params, authProfileId: "missing" }, admin),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("openclaw models auth login"),
      }),
    );
    expect(
      await rpc(
        "users.linkAuthProfile",
        {
          ...params,
          authProfileId: `personal:${randomUUID()}:${randomUUID()}`,
        },
        admin,
      ),
    ).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("your personal account list"),
      }),
    );
    expect(setUserProfileAuthLink).not.toHaveBeenCalled();
    expect(await status(flow)).toMatchObject({ status: "pending" });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(["direct", "shared-secret"] as const)(
    "uses the catalog and exact sensitive step for a %s caller without consuming a rejected answer",
    async (caller) => {
      if (caller === "shared-secret") {
        self.internal = { operatorRoleActor: { kind: "system" } };
      }
      expect(
        await rpc("users.authConnect.catalog", { profileId: "profile-1" }),
      ).toHaveBeenCalledWith(true, {
        providers: [
          { id: "openai", label: "OpenAI", methods: [{ id: "oauth", label: "Browser sign-in" }] },
        ],
      });
      const flow = await startFlow();
      const pending = await status(flow);
      const invalid = await rpc("users.authConnect.answer", {
        profileId: "profile-1",
        connectId: flow.connectId,
        stepId: pending.step.id,
        value: "secret-invalid",
      });
      expect(invalid).toHaveBeenCalledWith(true, {
        status: "pending",
        step: pending.step,
        error: expect.any(String),
      });
      expect(JSON.stringify(invalid.mock.calls)).not.toContain("secret-invalid");
      expect(registerSecretValueForRedaction).toHaveBeenCalledWith("secret-invalid");
      expect(exchange).not.toHaveBeenCalled();
      expect(
        await rpc("users.authConnect.answer", {
          profileId: "profile-1",
          connectId: flow.connectId,
          stepId: "stale",
          value: "synthetic-code",
        }),
      ).toHaveBeenCalledWith(true, {
        status: "pending",
        step: pending.step,
        error: expect.any(String),
      });
      await complete(flow);
      const result = await terminal(flow, "connected");
      expect(result).toEqual({
        status: "connected",
        authProfileId: "personal:profile-1:account-1",
        links: [
          { provider: "openai", authProfileId: "personal:profile-1:account-1", updatedAt: 1 },
        ],
      });
      expect(await complete(flow)).toHaveBeenCalledWith(true, result);
      expect(writes).toEqual([credential]);
      expect(exchange).toHaveBeenCalledOnce();
      expect(registerSecretValueForRedaction).toHaveBeenCalledWith("synthetic-code");
      expect(broadcast).toHaveBeenCalledExactlyOnceWith(
        "chat.metadata.changed",
        {},
        { dropIfSlow: true },
      );
    },
  );

  it("keeps server credentials and model defaults outside personal provider execution", async () => {
    config = {
      models: {
        providers: {
          openai: { apiKey: "server-only-key", baseUrl: "https://api.example.test", models: [] },
        },
      },
    };
    const flow = await startFlow();
    const ctx = runAuth.mock.calls[0]![0];
    expect(ctx).toMatchObject({
      config: {},
      env: {},
      secretInputMode: "plaintext",
      allowSecretRefPrompt: false,
    });
    expect(ctx.agentDir).toBeUndefined();
    expect(ctx.opts).toBeUndefined();
    exchange.mockResolvedValueOnce({
      ...authorized,
      configPatch: { agents: { defaults: { model: "ignored/model" } } },
      defaultModel: "ignored/model",
    });
    await complete(flow);
    await terminal(flow, "connected");
    expect(config.agents).toBeUndefined();
    expect(writes).toEqual([credential]);
  });

  it("records provider completion while a prompt is open without requiring an answer", async () => {
    const callback = createDeferredCore<ProviderAuthResult>();
    runAuth.mockImplementationOnce(async (ctx) => {
      const input = ctx.prompter.text({ message: "Paste callback", sensitive: true });
      return Promise.race([input.then(() => authorized), callback.promise]);
    });
    const flow = await startFlow();
    callback.resolve(authorized);
    expect(await terminal(flow, "connected")).not.toHaveProperty("step");
    expect(writes).toEqual([credential]);
  });

  it("observes the next provider step after a manual prompt is retired", async () => {
    const manual = new AbortController();
    runAuth.mockImplementationOnce(async (ctx) => {
      await ctx.prompter
        .text({ message: "Manual input", sensitive: true, signal: manual.signal })
        .catch(() => undefined);
      await ctx.prompter.note("Browser authorization received", "Continue sign-in");
      return authorized;
    });
    const flow = await startFlow();
    const first = await status(flow);
    manual.abort(new Error("Browser callback won"));
    await vi.waitFor(async () =>
      expect(await status(flow)).toMatchObject({ status: "pending", step: { type: "note" } }),
    );
    const next = await status(flow);
    expect(next.step.id).not.toBe(first.step.id);
    expect(
      await rpc("users.authConnect.answer", {
        profileId: "profile-1",
        connectId: flow.connectId,
        stepId: first.step.id,
        value: "stale",
      }),
    ).toHaveBeenCalledWith(true, {
      status: "pending",
      step: next.step,
      error: expect.any(String),
    });
    expect(writes).toEqual([]);
    expect(await status(flow)).toEqual(next);
    await rpc("users.authConnect.answer", {
      profileId: "profile-1",
      connectId: flow.connectId,
      stepId: next.step.id,
    });
    await terminal(flow, "connected");
    expect(writes).toEqual([credential]);
  });

  it("does not replay a rejected step retired during answer validation", async () => {
    const manual = new AbortController();
    runAuth.mockImplementationOnce(async (ctx) => {
      await ctx.prompter
        .text({
          message: "Manual input",
          sensitive: true,
          signal: manual.signal,
          validate: () => {
            // Browser completion retires the prompt before the service resumes
            // from the Promise returned by the synchronous validator's answer.
            queueMicrotask(() => manual.abort(new Error("Browser callback won")));
            return "Rejected answer";
          },
        })
        .catch(() => undefined);
      await ctx.prompter.note("Browser authorization received", "Continue sign-in");
      return authorized;
    });
    const flow = await startFlow();
    const first = await status(flow);
    const response = await rpc("users.authConnect.answer", {
      profileId: "profile-1",
      connectId: flow.connectId,
      stepId: first.step.id,
      value: "rejected-secret",
    });
    expect(response).toHaveBeenCalledWith(true, expect.objectContaining({ status: "pending" }));
    expect(response.mock.calls[0]?.[1]).not.toHaveProperty("error");
    expect(response.mock.calls[0]?.[1]).not.toHaveProperty("step.id", first.step.id);
    await vi.waitFor(async () =>
      expect(await status(flow)).toMatchObject({ status: "pending", step: { type: "note" } }),
    );
    const next = await status(flow);
    await rpc("users.authConnect.answer", {
      profileId: "profile-1",
      connectId: flow.connectId,
      stepId: next.step.id,
    });
    await terminal(flow, "connected");
    expect(writes).toEqual([credential]);
  });

  it.each(["status", "answer", "cancel"])(
    "replays %s with current links, not the original default",
    async (action) => {
      const flow = await startFlow();
      await complete(flow);
      await terminal(flow, "connected");
      linksByOwner.set("profile-1", []);
      service.supersede("profile-1", "openai");
      expect(
        await rpc(`users.authConnect.${action}`, {
          profileId: "profile-1",
          connectId: flow.connectId,
          ...(action === "answer" ? { stepId: "retired" } : {}),
        }),
      ).toHaveBeenCalledWith(true, {
        status: "connected",
        authProfileId: "personal:profile-1:account-1",
        links: [],
      });
      expect(writes).toEqual([credential]);
    },
  );

  it.each(["exchange", "identity", "unavailable"] as const)(
    "records a redacted %s failure",
    async (reason) => {
      if (reason === "exchange") {
        exchange.mockRejectedValueOnce(new Error("secret provider detail"));
      }
      if (reason === "identity") {
        exchange.mockResolvedValueOnce({ profiles: [] });
      }
      if (reason === "unavailable") {
        connectUserModelAccount.mockImplementationOnce(() => {
          throw new Error("secret database detail");
        });
      }
      const flow = await startFlow();
      await complete(flow);
      expect(await terminal(flow, "failed")).toEqual({ status: "failed", reason });
      expect(writes).toEqual([]);
    },
  );

  it.each(
    (["before", "during"] as const).flatMap((phase) =>
      (["disconnect", "invalidation", "role", "merge", "answerer disconnect"] as const).map(
        (change) => ({ phase, change }),
      ),
    ),
  )("fences $change $phase provider I/O", async ({ phase, change }) => {
    const writer: GatewayOperatorRoleDefinition = {
      agents: "*",
      scopes: ["operator.write"],
      sessions: { others: "none" },
    };
    config = { gateway: { roles: { default: "writer", definitions: { writer } } } };
    const deferred = createDeferredCore<ProviderAuthResult>();
    if (phase === "during") {
      exchange.mockReturnValueOnce(deferred.promise);
    }
    const ready = createDeferredCore();
    const beforeIo = createDeferredCore();
    if (phase === "before") {
      runAuth.mockImplementationOnce(async (ctx) => {
        const value = await ctx.prompter.text({ message: "Provider credential", sensitive: true });
        ready.resolve();
        await beforeIo.promise;
        ctx.assertCurrent?.();
        return exchange(value, ctx.signal);
      });
    }
    const flow = await startFlow();
    const answerer = change === "answerer disconnect" ? createClient() : self;
    await complete(flow, "profile-1", answerer);
    if (phase === "before") {
      await ready.promise;
    } else {
      await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    }
    if (change === "disconnect") {
      clients.delete(self);
    }
    if (change === "invalidation") {
      self.invalidated = true;
    }
    if (change === "role") {
      writer.scopes = ["operator.read"];
    }
    if (change === "merge") {
      resolveUserProfileId.mockImplementation((id) => (id === "profile-1" ? "profile-merged" : id));
    }
    if (change === "answerer disconnect") {
      clients.delete(answerer);
    }
    beforeIo.resolve();
    deferred.resolve(authorized);
    await Promise.allSettled([runAuth.mock.results[0]!.value]);
    if (phase === "before") {
      expect(exchange).not.toHaveBeenCalled();
    } else {
      expect(exchange).toHaveResolved();
    }
    // A merged-away owner cannot authorize even an observation of its old operation.
    const observer = createClient("profile-admin", ["operator.admin"]);
    if (change === "merge") {
      expect(
        await rpc(
          "users.authConnect.status",
          { profileId: "profile-1", connectId: flow.connectId },
          observer,
        ),
      ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
      expect(writes).toEqual([]);
      return;
    }
    config = {};
    expect(await terminal(flow, "failed", "profile-1", observer)).toEqual({
      status: "failed",
      reason: "authority",
    });
    expect(writes).toEqual([]);
  });

  it.each(["cancel", "supersede", "expiry", "stop"] as const)(
    "fences late credentials after %s",
    async (change) => {
      const deferred = createDeferredCore<ProviderAuthResult>();
      exchange.mockReturnValueOnce(deferred.promise);
      const flow = await startFlow();
      await complete(flow);
      await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
      const signal: AbortSignal = exchange.mock.calls[0]![1];
      if (change === "cancel") {
        await rpc("users.authConnect.cancel", {
          profileId: "profile-1",
          connectId: flow.connectId,
        });
      }
      if (change === "supersede") {
        service.supersede("profile-1", "openai");
      }
      if (change === "expiry") {
        vi.spyOn(Date, "now").mockReturnValue(flow.expiresAtMs + 1);
      }
      if (change === "stop") {
        await service.stop();
      }
      deferred.resolve(authorized);
      await vi.waitFor(() => expect(exchange).toHaveResolved());
      if (change === "stop") {
        service = createModelAccountConnectService({ getConfig: () => config });
        context.modelAccountConnectService = service;
      }
      expect(
        await terminal(flow, change === "expiry" || change === "stop" ? "expired" : "cancelled"),
      ).not.toHaveProperty("step");
      expect(signal.aborted).toBe(true);
      expect(writes).toEqual([]);
    },
  );

  it("retires replaced operations without letting an old cancel affect the new one", async () => {
    const first = await startFlow();
    const replacement = await startFlow();
    expect(
      await rpc("users.authConnect.cancel", { profileId: "profile-1", connectId: first.connectId }),
    ).toHaveBeenCalledWith(true, { status: "cancelled" });
    await complete(replacement);
    await terminal(replacement, "connected");
    expect(writes).toEqual([credential]);
  });

  it("bounds concurrent sign-ins and recovers capacity after cancellation", async () => {
    const admin = createClient("profile-admin", ["operator.admin"]);
    const flows = [];
    for (let index = 0; index < 8; index++) {
      flows.push(await startFlow(`profile-${index}`, admin));
    }
    expect(
      await rpc(
        "users.authConnect.start",
        { profileId: "profile-9", provider: "openai", method: "oauth" },
        admin,
      ),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "UNAVAILABLE" }));
    await rpc(
      "users.authConnect.cancel",
      { profileId: "profile-0", connectId: flows[0]!.connectId },
      admin,
    );
    expect((await startFlow("profile-9", admin)).connectId).toBeTruthy();
  });

  it("uses the same credential boundary for a catalog-provided API key", async () => {
    const keyCredential: AuthProfileCredential = {
      type: "api_key",
      provider: "example-ai",
      key: "synthetic-key",
    };
    resolvePersonalAccountAuthMethod.mockReturnValue({
      id: "api-key",
      label: "API key",
      kind: "api_key",
      run: runAuth,
    });
    exchange.mockResolvedValueOnce({
      profiles: [{ profileId: "ignored-id", credential: keyCredential }],
    });
    const started = await rpc("users.authConnect.start", {
      profileId: "profile-1",
      provider: "example-ai",
      method: "api-key",
    });
    const flow = started.mock.calls[0]![1] as UsersAuthConnectStartResult;
    await vi.waitFor(async () => expect(await status(flow)).toHaveProperty("step"));
    await complete(flow);
    await terminal(flow, "connected");
    expect(writes).toEqual([keyCredential]);
    const match = connectUserModelAccount.mock.calls[0]![0].matchesCredential;
    expect(match(keyCredential)).toBe(true);
    expect(match({ ...keyCredential, key: "different" })).toBe(false);
  });

  it("keeps a committed account connected when notification fails", async () => {
    broadcast.mockImplementation(() => {
      throw new Error("socket notification failed");
    });
    const flow = await startFlow();
    await complete(flow);
    await terminal(flow, "connected");
    expect(writes).toEqual([credential]);
    expect(warn).toHaveBeenCalledWith("chat metadata change notification failed");
  });

  it("rejects unavailable methods and unauthorized owners before provider execution", async () => {
    expect(
      await rpc("users.authConnect.start", {
        profileId: "profile-other",
        provider: "openai",
        method: "oauth",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
    expect(resolvePersonalAccountAuthMethod).not.toHaveBeenCalled();
    resolvePersonalAccountAuthMethod.mockReturnValueOnce(undefined);
    expect(
      await rpc("users.authConnect.start", {
        profileId: "profile-1",
        provider: "other",
        method: "import-native-login",
      }),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "INVALID_REQUEST" }));
    expect(runAuth).not.toHaveBeenCalled();
  });

  it.each([
    ["users.authConnect.start", { provider: "openai", method: "oauth" }],
    ["users.listAuthLinks", {}],
    ["users.linkAuthProfile", { authProfileId: "openai:shared" }],
    ["users.unlinkAuthProfile", { provider: "openai" }],
  ] as const)(
    "validates %s before consulting identity, state, or provider code",
    async (method, params) => {
      expect(
        await rpc(method, {
          ...params,
          profileId: "profile-1",
          unexpected: true,
        }),
      ).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(getUserProfileListItem).not.toHaveBeenCalled();
      expect(resolvePersonalAccountAuthMethod).not.toHaveBeenCalled();
      expect(listUserProfileAuthLinks).not.toHaveBeenCalled();
      expect(setUserProfileAuthLink).not.toHaveBeenCalled();
      expect(clearUserProfileAuthLink).not.toHaveBeenCalled();
    },
  );
});

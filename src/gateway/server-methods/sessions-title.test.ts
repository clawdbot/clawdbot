import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { connectUserModelAccount } from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { sessionTitleHandlers } from "./sessions-title.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  runIsolatedCompletion: vi.fn(),
  resolveRegisteredCatalogCreateTarget: vi.fn(),
}));

vi.mock("../../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: mocks.runIsolatedCompletion,
}));
vi.mock("./session-catalog.js", () => ({
  resolveRegisteredCatalogCreateTarget: mocks.resolveRegisteredCatalogCreateTarget,
}));

const cfg: OpenClawConfig = {
  agents: {
    entries: { main: {} },
    defaults: {
      model: { primary: "title-test/primary" },
      utilityModel: "title-test/utility",
    },
  },
};

let testState: OpenClawTestState;
let ownerId: string;
let otherId: string;
let personalAccountId: string;

function connectedClient(profileId?: string): GatewayClient {
  return {
    connId: "title-preparation-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.write"],
    },
    ...(profileId
      ? {
          authenticatedUserProfile: {
            profileId,
            displayName: "Title Test Person",
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

async function prepare(
  params: Record<string, unknown>,
  config: OpenClawConfig = cfg,
  client: GatewayClient | null = null,
  controls: { connections?: ReadonlySet<GatewayClient>; signal?: AbortSignal } = {},
) {
  const respond = vi.fn();
  const method = "sessions.title.prepare";
  const connections = controls.connections ?? new Set(client ? [client] : []);
  const context: Pick<GatewayRequestContext, "getRuntimeConfig" | "getClientConnIds"> = {
    getRuntimeConfig: () => config,
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) => {
      const connIds = new Set<string>();
      for (const candidate of connections) {
        if (candidate.connId && (!filter || filter(candidate))) {
          connIds.add(candidate.connId);
        }
      }
      return connIds;
    },
  };
  await sessionTitleHandlers[method]!({
    req: { type: "req", id: "draft-title", method, params },
    params,
    respond,
    context: context as GatewayRequestContext,
    client,
    signal: controls.signal,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("sessions.title.prepare", () => {
  beforeAll(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal" });
    ownerId = ensureProfileForEmail("title-owner@example.test").id;
    otherId = ensureProfileForEmail("title-other@example.test").id;
    personalAccountId = connectUserModelAccount({
      ownerProfileId: ownerId,
      credential: { type: "token", provider: "title-test", token: "synthetic-title-token" },
      assertCurrent() {},
    }).authProfileId;
  });

  afterAll(async () => {
    await testState.cleanup();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.runIsolatedCompletion.mockResolvedValue({ text: 'Title: "Draft session title"' });
    mocks.resolveRegisteredCatalogCreateTarget.mockReturnValue({
      ok: false,
      unknownCatalog: true,
      message: "unknown catalog",
    });
  });

  it("returns a normalized title from exactly one utility completion", async () => {
    const respond = await prepare({ agentId: "main", message: "Plan a new session" });
    expect(respond).toHaveBeenCalledWith(true, { title: "Draft session title" });
    expect(mocks.runIsolatedCompletion).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: "title-test",
        model: "utility",
        prompt: "Plan a new session",
        outputTextPolicy: "strict-visible",
      }),
    );
  });

  it.each(["automatic", "personal"] as const)(
    "returns a null title without primary fallback when %s utility inference fails",
    async (selection) => {
      mocks.runIsolatedCompletion.mockRejectedValue(new Error("private provider diagnostic"));
      const respond = await prepare(
        {
          agentId: "main",
          message: "Private draft",
          ...(selection === "personal" ? { model: `title-test/primary@${personalAccountId}` } : {}),
        },
        cfg,
        connectedClient(ownerId),
      );
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, { title: null });
      expect(mocks.runIsolatedCompletion).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["", "invalid/"])(
    "does not route disabled or malformed utility setting %j to the primary",
    async (utilityModel) => {
      const config = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, utilityModel } },
      };
      expect(
        await prepare({ agentId: "main", message: "Plan a session" }, config),
      ).toHaveBeenCalledWith(true, { title: null });
      expect(mocks.runIsolatedCompletion).not.toHaveBeenCalled();
    },
  );

  it.each([
    { message: "" },
    { message: "   " },
    { message: "/new" },
    { message: "Secret draft", incognito: true },
    { message: "Catalog draft", catalogId: "missing" },
  ])("skips non-speculative input %# without inference", async (params) => {
    expect(await prepare({ agentId: "main", ...params })).toHaveBeenCalledWith(true, {
      title: null,
    });
    expect(mocks.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it.each([
    { message: "Draft", agentId: "missing" },
    { message: "x".repeat(1_001), agentId: "main" },
    { message: "Draft", agentId: "main", sessionKey: "existing-session" },
    { message: "Draft", agentId: "main", model: "title-test/primary", catalogId: "catalog" },
  ])("rejects invalid selection or an existing-session target %#", async (params) => {
    expect(await prepare(params)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mocks.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("enforces the operator's allowed creation agent before inference", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      gateway: {
        roles: {
          default: "limited",
          definitions: {
            limited: { agents: [], scopes: ["operator.write"], sessions: { others: "none" } },
          },
        },
      },
    };
    expect(
      await prepare({ agentId: "main", message: "Draft" }, config, connectedClient(ownerId)),
    ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
    expect(mocks.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it("skips a selected model denied by the creation agent's model policy", async () => {
    const config = {
      ...cfg,
      agents: {
        ...cfg.agents,
        entries: { main: { modelPolicy: { allow: ["title-test/primary"] } } },
      },
    };
    expect(
      await prepare({ agentId: "main", message: "Draft", model: "other-model/denied" }, config),
    ).toHaveBeenCalledWith(true, { title: null });
    expect(mocks.runIsolatedCompletion).not.toHaveBeenCalled();
  });

  it.each([
    ["openai", "codex"],
    ["other-title", undefined],
  ])(
    "uses only the catalog runtime compatible with utility provider %s",
    async (provider, runtime) => {
      const config = {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: { ...cfg.agents?.defaults, utilityModel: `${provider}/synthetic-utility` },
        },
      };
      mocks.resolveRegisteredCatalogCreateTarget.mockReturnValue({
        ok: true,
        target: {
          model: "openai/synthetic-primary",
          agentRuntime: "codex",
          pluginOwnerId: "codex",
        },
      });
      expect(
        await prepare({ agentId: "main", message: "Draft", catalogId: "native-catalog" }, config),
      ).toHaveBeenCalledWith(true, { title: "Draft session title" });
      expect(mocks.runIsolatedCompletion).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider, model: "synthetic-utility" }),
      );
      expect(mocks.runIsolatedCompletion.mock.calls[0]?.[0].agentHarnessRuntimeOverride).toBe(
        runtime,
      );
    },
  );

  it("inherits the selected model's same-provider auth profile for utility inference", async () => {
    expect(
      await prepare({ agentId: "main", message: "Draft", model: "title-test/primary@work" }),
    ).toHaveBeenCalledWith(true, { title: "Draft session title" });
    expect(mocks.runIsolatedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "title-test", model: "utility", authProfileId: "work" }),
    );
  });

  it("uses the connected owner's personal account for title inference", async () => {
    expect(
      await prepare(
        {
          agentId: "main",
          message: "Personal draft",
          model: `title-test/primary@${personalAccountId}`,
        },
        cfg,
        connectedClient(ownerId),
      ),
    ).toHaveBeenCalledWith(true, { title: "Draft session title" });
    expect(mocks.runIsolatedCompletion).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: "title-test",
        model: "utility",
        authProfileId: personalAccountId,
      }),
    );
  });

  it.each(["foreign", "delegated", "unidentified"] as const)(
    "rejects %s personal title selection before inference",
    async (kind) => {
      const client = connectedClient(
        kind === "foreign" ? otherId : kind === "delegated" ? ownerId : undefined,
      );
      if (kind === "delegated") {
        client.internal = {
          syntheticClient: true,
          agentToolCaller: { agentId: "main", sessionKey: "agent:main:dashboard:delegated-title" },
        };
      }
      const respond = await prepare(
        {
          agentId: "main",
          message: "Personal draft",
          model: `title-test/primary@${personalAccountId}`,
        },
        cfg,
        client,
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(mocks.runIsolatedCompletion).not.toHaveBeenCalled();
    },
  );

  it.each([
    { loss: "disconnected", completion: "succeeds" },
    { loss: "replaced", completion: "succeeds" },
    { loss: "role revoked", completion: "succeeds" },
    { loss: "agent access revoked", completion: "succeeds" },
    { loss: "request aborted", completion: "succeeds" },
    { loss: "disconnected", completion: "fails" },
  ] as const)(
    "rejects a $loss personal selection when pending inference $completion",
    async ({ loss, completion }) => {
      const writer: GatewayOperatorRoleDefinition = {
        agents: "*",
        scopes: ["operator.write"],
        sessions: { others: "none" },
      };
      const config: OpenClawConfig = {
        ...cfg,
        gateway: { roles: { default: "writer", definitions: { writer } } },
      };
      const client = connectedClient(ownerId);
      const connections = new Set([client]);
      const abort = new AbortController();
      const inference = createDeferredCore<{ text: string }>();
      mocks.runIsolatedCompletion.mockReturnValueOnce(inference.promise);
      const pending = prepare(
        {
          agentId: "main",
          message: "Personal draft",
          model: `title-test/primary@${personalAccountId}`,
        },
        config,
        client,
        { connections, signal: abort.signal },
      );
      try {
        await vi.waitFor(() => expect(mocks.runIsolatedCompletion).toHaveBeenCalledOnce());
        if (loss === "disconnected" || loss === "replaced") {
          connections.delete(client);
          if (loss === "replaced") {
            connections.add(connectedClient(ownerId));
          }
        } else if (loss === "role revoked") {
          writer.scopes = ["operator.read"];
        } else if (loss === "agent access revoked") {
          writer.agents = [];
        } else {
          abort.abort();
        }
      } finally {
        if (completion === "fails") {
          inference.reject(new Error("private provider diagnostic"));
        } else {
          inference.resolve({ text: "Title after authority ended" });
        }
      }
      expect(await pending).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
      expect(mocks.runIsolatedCompletion).toHaveBeenCalledTimes(1);
    },
  );

  it("does not send the primary provider's auth profile to another utility provider", async () => {
    const config = {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: { ...cfg.agents?.defaults, utilityModel: "other-title/utility" },
      },
    };
    await prepare({ agentId: "main", message: "Draft", model: "title-test/primary@work" }, config);
    expect(mocks.runIsolatedCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "other-title",
        model: "utility",
        authProfileId: undefined,
      }),
    );
  });
});

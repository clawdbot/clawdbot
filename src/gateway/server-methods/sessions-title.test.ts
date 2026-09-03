import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionTitleHandlers } from "./sessions-title.js";

const mocks = vi.hoisted(() => ({
  runIsolatedCompletion: vi.fn(),
  authorizeGatewaySessionCreation: vi.fn(),
  resolveRegisteredCatalogCreateTarget: vi.fn(),
}));

vi.mock("../../agents/isolated-completion.js", () => ({
  runIsolatedCompletion: mocks.runIsolatedCompletion,
}));
vi.mock("../operator-role-policy.js", () => ({
  authorizeGatewaySessionCreation: mocks.authorizeGatewaySessionCreation,
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

async function prepare(params: Record<string, unknown>, config: OpenClawConfig = cfg) {
  const respond = vi.fn();
  const method = "sessions.title.prepare";
  await sessionTitleHandlers[method]!({
    req: { type: "req", id: "draft-title", method, params },
    params,
    respond,
    context: { getRuntimeConfig: () => config } as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("sessions.title.prepare", () => {
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

  it("does not fall back to the primary when utility inference fails", async () => {
    mocks.runIsolatedCompletion.mockRejectedValue(new Error("private provider diagnostic"));
    const respond = await prepare({ agentId: "main", message: "Private draft" });
    expect(respond).toHaveBeenCalledWith(true, { title: null });
    expect(mocks.runIsolatedCompletion).toHaveBeenCalledTimes(1);
  });

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
    const error = { code: "FORBIDDEN", message: "Agent not allowed" };
    mocks.authorizeGatewaySessionCreation.mockReturnValue(error);
    expect(await prepare({ agentId: "main", message: "Draft" })).toHaveBeenCalledWith(
      false,
      undefined,
      error,
    );
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

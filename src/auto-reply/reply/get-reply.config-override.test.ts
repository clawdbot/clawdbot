// Tests get-reply config override handling for a single inbound turn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildGetReplyCtx,
  createGetReplySessionState,
  expectResolvedTelegramTimezone,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
  loadResolvedPublishedModelCatalogOwner: vi.fn(),
}));
registerGetReplyRuntimeOverrides(mocks);

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadResolvedPublishedModelCatalogOwner: mocks.loadResolvedPublishedModelCatalogOwner,
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let loadConfigMock: typeof import("../../config/config.js").getRuntimeConfig;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ getRuntimeConfig: loadConfigMock } = await import("../../config/config.js"));
}

describe("getReplyFromConfig configOverride", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    mocks.loadResolvedPublishedModelCatalogOwner.mockReset();
    vi.mocked(loadConfigMock).mockReset();

    vi.mocked(loadConfigMock).mockReturnValue({});
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockResolvedValue(createGetReplySessionState());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("merges configOverride over fresh getRuntimeConfig()", async () => {
    vi.mocked(loadConfigMock).mockReturnValue({
      channels: {
        telegram: {
          botToken: "resolved-telegram-token",
        },
      },
      agents: {
        defaults: {
          userTimezone: "UTC",
        },
      },
    } satisfies OpenClawConfig);

    await getReplyFromConfig(buildGetReplyCtx(), undefined, {
      agents: {
        defaults: {
          userTimezone: "America/New_York",
        },
      },
    } as OpenClawConfig);

    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
  });

  it("uses complete configOverride without reloading config", async () => {
    const { withFullRuntimeReplyConfig } = await import("./get-reply-fast-path.js");
    vi.mocked(loadConfigMock).mockImplementation(() => {
      throw new Error("getRuntimeConfig should not be called for complete runtime config");
    });

    await getReplyFromConfig(
      buildGetReplyCtx(),
      undefined,
      withFullRuntimeReplyConfig({
        channels: {
          telegram: {
            botToken: "resolved-telegram-token",
          },
        },
        agents: {
          defaults: {
            userTimezone: "America/New_York",
          },
        },
      } satisfies OpenClawConfig),
    );

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(mocks.loadResolvedPublishedModelCatalogOwner).not.toHaveBeenCalled();
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
  });

  it("uses the published model owner generation for gateway runtime config", async () => {
    const { withPublishedRuntimeReplyConfig } = await import("./get-reply-fast-path.js");
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const ownerConfig = {
      channels: {
        telegram: {
          botToken: "resolved-telegram-token",
        },
      },
      agents: {
        defaults: {
          userTimezone: "America/New_York",
        },
        list: [{ id: "main", default: true }],
      },
    } satisfies OpenClawConfig;
    const preparedModelCatalog = { entries: [], routeVariants: [] };
    mocks.loadResolvedPublishedModelCatalogOwner.mockResolvedValue({
      agentId: "main",
      agentDir: "/tmp/prepared-model-owner",
      workspaceDir: "/tmp/prepared-model-workspace",
      config: ownerConfig,
      modelCatalog: preparedModelCatalog,
    });

    await getReplyFromConfig(
      buildGetReplyCtx(),
      undefined,
      withPublishedRuntimeReplyConfig({
        agents: { defaults: { userTimezone: "UTC" } },
      } satisfies OpenClawConfig),
    );

    expect(mocks.loadResolvedPublishedModelCatalogOwner).toHaveBeenCalledWith({
      agentId: "main",
    });
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        agentDir: "/tmp/prepared-model-owner",
        workspaceDir: "/tmp/prepared-model-workspace",
        preparedModelCatalog,
      }),
    );
  });

  it("rejects a published model owner that crosses the admitted session agent", async () => {
    const { withPublishedRuntimeReplyConfig } = await import("./get-reply-fast-path.js");
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    mocks.loadResolvedPublishedModelCatalogOwner.mockResolvedValue({
      agentId: "worker",
      agentDir: "/tmp/prepared-model-owner",
      workspaceDir: "/tmp/prepared-model-workspace",
      config: { agents: { list: [{ id: "worker", default: true }] } },
      modelCatalog: { entries: [], routeVariants: [] },
    });

    await expect(
      getReplyFromConfig(
        buildGetReplyCtx(),
        undefined,
        withPublishedRuntimeReplyConfig({} satisfies OpenClawConfig),
      ),
    ).rejects.toThrow("reply model catalog owner changed from main to worker");
  });

  it("marks a frozen complete config without changing its identity or own keys", async () => {
    const { withFullRuntimeReplyConfig } = await import("./get-reply-fast-path.js");
    const cfg = Object.freeze({
      agents: { defaults: { userTimezone: "America/New_York" } },
      channels: { telegram: { botToken: "resolved-telegram-token" } },
    } satisfies OpenClawConfig);
    const ownKeys = Reflect.ownKeys(cfg);
    vi.mocked(loadConfigMock).mockImplementation(() => {
      throw new Error("getRuntimeConfig should not be called for complete runtime config");
    });

    const marked = withFullRuntimeReplyConfig(cfg);
    await getReplyFromConfig(buildGetReplyCtx(), undefined, marked);

    expect(marked).toBe(cfg);
    expect(Reflect.ownKeys(cfg)).toEqual(ownKeys);
    expect(loadConfigMock).not.toHaveBeenCalled();
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
  });
});

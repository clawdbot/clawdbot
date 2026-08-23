// Tests get-reply config override handling for a single inbound turn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedReplyDispatchRuntime } from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  buildGetReplyCtx,
  createGetReplySessionState,
  expectResolvedTelegramTimezone,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import "./get-reply.test-runtime-mocks.js";
import { bindPreparedReplyDispatchRuntime } from "./prepared-reply-dispatch-context.js";

const mocks = vi.hoisted(() => ({
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("../../plugin-sdk/reply-runtime.js").getReplyFromConfig;
let loadConfigMock: typeof import("../../config/config.js").getRuntimeConfig;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await import("../../plugin-sdk/reply-runtime.js"));
  ({ getRuntimeConfig: loadConfigMock } = await import("../../config/config.js"));
}

function createPreparedDispatchRuntime(
  overrides: Partial<PreparedReplyDispatchRuntime> = {},
): PreparedReplyDispatchRuntime {
  return Object.freeze({
    agentId: "main",
    agentDir: "/tmp/prepared-model-owner",
    workspaceDir: "/tmp/prepared-model-workspace",
    config: {
      channels: { telegram: { botToken: "resolved-telegram-token" } },
      agents: {
        defaults: { userTimezone: "America/New_York" },
        list: [{ id: "main", default: true }],
      },
    },
    modelCatalog: { entries: [], routeVariants: [] },
    inboundPluginRegistry: createEmptyPluginRegistry(),
    ...overrides,
  });
}

describe("getReplyFromConfig configOverride", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
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

    const conflictingRuntime = createPreparedDispatchRuntime();
    await bindPreparedReplyDispatchRuntime(conflictingRuntime, getReplyFromConfig)(
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
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: expect.not.stringMatching(/prepared-model-owner/),
        preparedModelCatalog: undefined,
      }),
    );
  });

  it("uses one request-scoped prepared runtime through the raw Plugin SDK resolver", async () => {
    const preparedRuntime = createPreparedDispatchRuntime();
    vi.mocked(loadConfigMock).mockImplementation(() => {
      throw new Error("getRuntimeConfig should not be called for a prepared Gateway dispatch");
    });

    await bindPreparedReplyDispatchRuntime(preparedRuntime, getReplyFromConfig)(buildGetReplyCtx());

    expect(loadConfigMock).not.toHaveBeenCalled();
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        agentDir: "/tmp/prepared-model-owner",
        workspaceDir: "/tmp/prepared-model-workspace",
        preparedModelCatalog: preparedRuntime.modelCatalog,
      }),
    );
  });

  it("rejects a prepared dispatch runtime that crosses the admitted session agent", async () => {
    const preparedRuntime = createPreparedDispatchRuntime({
      agentId: "worker",
      config: { agents: { list: [{ id: "worker", default: true }] } },
    });

    await expect(
      bindPreparedReplyDispatchRuntime(preparedRuntime, getReplyFromConfig)(buildGetReplyCtx()),
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

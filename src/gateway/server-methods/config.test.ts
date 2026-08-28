/**
 * Tests for config gateway methods, writes, validation, and auth transitions.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { clearConfigSchemaResponseCacheForTests, configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const configWriteMocks = vi.hoisted(() => ({
  commitGatewayConfigWrite: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

vi.mock("../../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
  return {
    ...actual,
    readConfigFileSnapshotForWrite: configWriteMocks.readConfigFileSnapshotForWrite,
  };
});

// This suite owns config patch/merge behavior, while plugin validation is covered by
// config.plugin-validation.test.ts and validation.channel-metadata.test.ts.
vi.mock("../../config/validation.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/validation.js")>(
    "../../config/validation.js",
  );
  return {
    ...actual,
    validateConfigObjectRawWithPlugins: vi.fn((config: OpenClawConfig) => ({
      ok: true,
      config,
      warnings: [],
    })),
    validateConfigObjectWithPlugins: vi.fn((config: OpenClawConfig) => ({
      ok: true,
      config,
      warnings: [],
    })),
  };
});

// Secret materialization has dedicated runtime suites; keep these handler tests on
// their config-write boundary instead of loading every provider and plugin artifact.
vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
    config,
  })),
}));

vi.mock("./config-write-flow.js", async () => {
  const actual =
    await vi.importActual<typeof import("./config-write-flow.js")>("./config-write-flow.js");
  return {
    ...actual,
    commitGatewayConfigWrite: configWriteMocks.commitGatewayConfigWrite,
    resolveGatewayConfigRestartWriteResult: vi.fn(async () => ({
      payload: { kind: "config-patch", mode: "config.patch", configPath: "/tmp/openclaw.json" },
      sentinelPersisted: false,
      restart: undefined,
    })),
  };
});

const { execOpenPathMock, loadGatewayRuntimeConfigSchemaMock } = vi.hoisted(() => ({
  execOpenPathMock: vi.fn(),
  loadGatewayRuntimeConfigSchemaMock: vi.fn(() => ({
    schema: { type: "object" },
    uiHints: undefined as Record<string, { advanced?: boolean }> | undefined,
    version: "test-schema",
  })),
}));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: execOpenPathMock };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
}));

function mockOpenPathError(error: Error) {
  execOpenPathMock.mockRejectedValue(error);
}

let storedConfig: OpenClawConfig;
let storedHash: string;
let nextHash: number;
let modelNormalizationPluginMetadata: PluginMetadataSnapshot | undefined;

function currentWriteSnapshot() {
  const result = createConfigWriteSnapshot(storedConfig);
  result.snapshot.hash = storedHash;
  result.snapshot.raw = JSON.stringify(storedConfig);
  if (modelNormalizationPluginMetadata) {
    result.writeOptions = {
      basePluginMetadataSnapshot: modelNormalizationPluginMetadata,
    } as never;
  }
  return result;
}

async function invokeConfigPatch(args: {
  raw: unknown;
  baseHash?: string;
  replacePaths?: string[];
}) {
  const harness = createConfigHandlerHarness({
    method: "config.patch",
    params: {
      raw: JSON.stringify(args.raw),
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
      ...(args.replacePaths ? { replacePaths: args.replacePaths } : {}),
    },
  });
  await expectDefined(
    configHandlers["config.patch"],
    'configHandlers["config.patch"] test invariant',
  )(harness.options);
  return harness;
}

function startConfigWrite(
  method: "config.patch" | "config.apply",
  args: { raw: unknown; baseHash?: string },
) {
  const harness = createConfigHandlerHarness({
    method,
    params: {
      raw: JSON.stringify(args.raw),
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
    },
  });
  const handler = expectDefined(
    configHandlers[method],
    `configHandlers["${method}"] test invariant`,
  );
  return { harness, operation: handler(harness.options) };
}

async function invokeConfigSchema() {
  const harness = createConfigHandlerHarness({ method: "config.schema" });
  await expectDefined(
    configHandlers["config.schema"],
    'configHandlers["config.schema"] test invariant',
  )(harness.options);
  return harness;
}

beforeEach(() => {
  storedConfig = {};
  storedHash = "base-hash";
  nextHash = 1;
  modelNormalizationPluginMetadata = undefined;
  configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () =>
    currentWriteSnapshot(),
  );
  configWriteMocks.commitGatewayConfigWrite.mockImplementation(
    async ({
      snapshot,
      nextConfig,
    }: {
      snapshot: { hash?: string };
      nextConfig: OpenClawConfig;
    }) => {
      if (snapshot.hash !== storedHash) {
        throw new ConfigMutationConflictError("config changed since last load");
      }
      storedConfig = nextConfig;
      storedHash = `next-hash-${nextHash}`;
      nextHash += 1;
      return {
        path: "/tmp/openclaw.json",
        config: storedConfig,
        hash: storedHash,
        queueFollowUp: vi.fn(),
      };
    },
  );
});

async function invokeConfigOpenFile() {
  const harness = createConfigHandlerHarness({ method: "config.openFile" });
  await expectDefined(
    configHandlers["config.openFile"],
    'configHandlers["config.openFile"] test invariant',
  )(harness.options);
  return harness;
}

afterEach(() => {
  vi.useRealTimers();
  clearConfigSchemaResponseCacheForTests();
  resetPluginRuntimeStateForTest();
  vi.clearAllMocks();
});

describe("config application settlement", () => {
  it("does not acknowledge a persisted write before its runtime application", async () => {
    let settleApplication!: (status: "applied") => void;
    const application = new Promise<"applied">((resolve) => {
      settleApplication = resolve;
    });
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async () => ({
      path: "/tmp/openclaw.json",
      config: { hooks: { enabled: true } },
      hash: "settled-hash",
      application,
      queueFollowUp: vi.fn(),
    }));

    const { harness, operation } = startConfigWrite("config.patch", {
      raw: { hooks: { enabled: true } },
      baseHash: "base-hash",
    });
    await vi.waitFor(() =>
      expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce(),
    );

    expect(harness.respond).not.toHaveBeenCalled();

    settleApplication("applied");
    await operation;
    expect(harness.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true }),
      undefined,
    );
  });

  it.each(["config.patch", "config.apply"] as const)(
    "reports %s post-commit recovery without claiming the active config was unapplied",
    async (method) => {
      const queueFollowUp = vi.fn();
      configWriteMocks.commitGatewayConfigWrite.mockResolvedValueOnce({
        path: "/tmp/openclaw.json",
        config: { hooks: { enabled: true } },
        hash: "recovery-hash",
        application: Promise.resolve("applied-restart-required"),
        queueFollowUp,
      });

      const { harness, operation } = startConfigWrite(method, {
        raw: { hooks: { enabled: true } },
        baseHash: "base-hash",
      });
      await operation;

      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("updated the active Gateway"),
        }),
      );
      for (const excluded of ["was not applied", "reapply"]) {
        expect(harness.respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: expect.not.stringContaining(excluded) }),
        );
      }
      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          message: expect.stringContaining("wait for the Gateway to restart"),
        }),
      );
      expect(queueFollowUp).toHaveBeenCalledOnce();
    },
  );

  it.each(["superseded", "failed", "stopped", "unclaimed"] as const)(
    "reports a persisted write whose runtime application was %s",
    async (outcome) => {
      const queueFollowUp = vi.fn();
      configWriteMocks.commitGatewayConfigWrite.mockResolvedValueOnce({
        path: "/tmp/openclaw.json",
        config: { hooks: { enabled: true } },
        hash: `${outcome}-hash`,
        application: Promise.resolve(outcome),
        queueFollowUp,
      });

      const { harness, operation } = startConfigWrite("config.patch", {
        raw: { hooks: { enabled: true } },
        baseHash: "base-hash",
      });
      await operation;

      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("persisted but was not applied"),
        }),
      );
      expect(harness.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("use config.apply") }),
      );
      expect(queueFollowUp).toHaveBeenCalledOnce();
    },
  );
});

describe("config.openFile", () => {
  it("opens the configured file without shell interpolation", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config $(touch pwned).json" }, async () => {
      execOpenPathMock.mockImplementation(async (command: { command: string; args: string[] }) => {
        expect(["open", "xdg-open", "powershell.exe"]).toContain(command.command);
        expect(command.args).toEqual(["/tmp/config $(touch pwned).json"]);
        return { stdout: "", stderr: "" };
      });

      const { respond } = await invokeConfigOpenFile();

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: true,
          path: "/tmp/config $(touch pwned).json",
        },
        undefined,
      );
    });
  });

  it("returns a detailed error and logs details when the opener fails", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config.json" }, async () => {
      mockOpenPathError(Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));

      const { respond, logGateway } = await invokeConfigOpenFile();

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: false,
          path: "/tmp/config.json",
          error: "Failed to open config file: spawn xdg-open ENOENT",
        },
        undefined,
      );
      expect(logGateway.warn).toHaveBeenCalledWith(
        "config.openFile failed path=/tmp/config.json: spawn xdg-open ENOENT",
      );
    });
  });

  it("does not split surrogate pairs when truncating the failed config path", async () => {
    const pathPrefix = `/tmp/${"a".repeat(111)}`;
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: `${pathPrefix}😀tail.json` }, async () => {
      mockOpenPathError(new Error("open failed"));

      const { logGateway } = await invokeConfigOpenFile();

      expect(logGateway.warn).toHaveBeenCalledWith(
        `config.openFile failed path=${pathPrefix}...: open failed`,
      );
    });
  });

  it("returns actionable headless environment error when xdg-open reports no method available", async () => {
    await withEnvAsync({ OPENCLAW_CONFIG_PATH: "/tmp/config.json" }, async () => {
      mockOpenPathError(new Error("xdg-open: no method available for opening '/tmp/config.json'"));

      const { respond, logGateway } = await invokeConfigOpenFile();

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: false,
          path: "/tmp/config.json",
          error:
            "Cannot open file in headless environment. File path: /tmp/config.json. This environment appears to lack a graphical or terminal browser handler.",
        },
        undefined,
      );
      expect(logGateway.warn).toHaveBeenCalledWith(
        "config.openFile failed path=/tmp/config.json: xdg-open: no method available for opening '/tmp/config.json'",
      );
    });
  });
});

describe("config schema response cache", () => {
  it("returns resolved tier metadata through config.schema", async () => {
    loadGatewayRuntimeConfigSchemaMock.mockReturnValueOnce({
      schema: { type: "object" },
      uiHints: { "gateway.port": { advanced: false } },
      version: "test-schema",
    });
    const harness = await invokeConfigSchema();

    expect(harness.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        uiHints: { "gateway.port": { advanced: false } },
      }),
      undefined,
    );
  });

  it("reuses a recent schema build across burst config requests", async () => {
    await invokeConfigSchema();
    await invokeConfigSchema();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(1);
  });

  it("rebuilds after config writes change schema inputs", async () => {
    await invokeConfigSchema();
    const patch = await invokeConfigPatch({ raw: { ui: { prefs: { theme: "knot" } } } });

    expect(patch.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true }),
      undefined,
    );
    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(1);

    await invokeConfigSchema();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(2);
  });

  it("rebuilds when the active plugin registry generation changes", async () => {
    await invokeConfigSchema();
    setActivePluginRegistry(createTestRegistry([]));
    await invokeConfigSchema();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(2);
  });
});

describe("config.patch hash-free ui.prefs LWW", () => {
  it("persists a ui.prefs-only patch and returns the committed hash", async () => {
    const { respond } = await invokeConfigPatch({ raw: { ui: { prefs: { theme: "knot" } } } });

    expect(storedConfig.ui?.prefs?.theme).toBe("knot");
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, hash: "next-hash-1" }),
      undefined,
    );
  });

  it("rejects a hash-free patch outside the LWW subtree", async () => {
    const { respond } = await invokeConfigPatch({ raw: { gateway: { port: 19_001 } } });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
  });

  it("rejects a mixed hash-free patch and names the guarded path", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } }, gateway: { port: 19_001 } },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      // The operator must see which path needs the base hash; a bare
      // "hash required" with no path was a dead-end error.
      expect.objectContaining({
        message: expect.stringContaining("config base hash required for gateway.port"),
      }),
    );
    expect(storedConfig).toEqual({});
  });

  it("rejects an empty-object structural change outside the LWW subtree", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } }, gateway: {} },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
  });

  it.each([
    { name: "ui.prefs deletion", raw: { ui: { prefs: null } } },
    { name: "ui deletion", raw: { ui: null } },
    { name: "scalar ui.prefs", raw: { ui: { prefs: "stale-container" } } },
  ])("rejects hash-free container operation: $name", async ({ raw }) => {
    storedConfig = { ui: { prefs: { theme: "claw" } } };

    const { respond } = await invokeConfigPatch({ raw });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("allows a hash-free per-key null deletion below ui.prefs", async () => {
    storedConfig = { ui: { prefs: { chatFollowUpMode: "queue", theme: "claw" } } };

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { chatFollowUpMode: null } } },
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ hash: "next-hash-1" }),
      undefined,
    );
    expect(storedConfig.ui?.prefs).toEqual({ theme: "claw" });
  });

  it("keeps destructive array replacement explicit for hash-free patches", async () => {
    storedConfig = { ui: { prefs: { sidebarEntries: ["route:usage", "route:tasks"] } } };

    const rejected = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:usage"] } } },
    });
    expect(rejected.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config.patch would remove entries from array path(s)"),
      }),
    );

    const accepted = await invokeConfigPatch({
      raw: { ui: { prefs: { sidebarEntries: ["route:usage"] } } },
      replacePaths: ["ui.prefs.sidebarEntries"],
    });
    expect(accepted.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ hash: "next-hash-1" }),
      undefined,
    );
    expect(storedConfig.ui?.prefs?.sidebarEntries).toEqual(["route:usage"]);
  });

  it("returns a noop for an unchanged hash-free patch", async () => {
    storedConfig = { ui: { prefs: { theme: "knot" } } };

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ noop: true }), undefined);
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("preserves stale-hash rejection for strict patches", async () => {
    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
      baseHash: "stale-hash",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config changed since last load"),
      }),
    );
  });

  it("surfaces a hash-free commit race without replaying stale intent", async () => {
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async () => {
      storedConfig = { ui: { prefs: { locale: "de" } } };
      storedHash = "raced-hash";
      throw new ConfigMutationConflictError("config changed since last load");
    });

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config changed since last load"),
      }),
    );
    expect(storedConfig.ui?.prefs).toEqual({ locale: "de" });
  });

  it("advises retry only for retryable mutation conflicts", async () => {
    configWriteMocks.commitGatewayConfigWrite.mockImplementationOnce(async () => {
      throw new ConfigMutationConflictError("config path owned by another writer", {
        retryable: false,
      });
    });

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } } },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      // A non-retryable conflict fails the retry too; advising it is a dead end.
      expect.objectContaining({
        message: "config path owned by another writer",
      }),
    );
  });
});

describe("config.patch ID-keyed arrays", () => {
  it("rejects duplicate IDs before applying an ID-merged array patch", async () => {
    storedConfig = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://example.invalid",
            models: [{ id: "one", name: "One" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { respond } = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            custom: {
              models: [
                { id: "one", name: "First" },
                { id: "one", name: "Second" },
              ],
            },
          },
        },
      },
      baseHash: "base-hash",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("duplicate ID one") }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  it("allows duplicate IDs for an explicit array replacement", async () => {
    storedConfig = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://example.invalid",
            models: [{ id: "one", name: "One" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { respond } = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            custom: {
              models: [
                { id: "one", name: "First" },
                { id: "one", name: "Second" },
              ],
            },
          },
        },
      },
      baseHash: "base-hash",
      replacePaths: ["models.providers.custom.models"],
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, hash: "next-hash-1" }),
      undefined,
    );
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();

    const followUp = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            custom: { models: [{ id: "one", name: "Third" }] },
          },
        },
      },
      baseHash: "next-hash-1",
    });

    expect(followUp.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("current config contains duplicate ID one"),
      }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalledOnce();
  });
});

describe("config.patch model input normalization", () => {
  it("uses write-snapshot policies before merging manifest-backed model IDs", async () => {
    modelNormalizationPluginMetadata = {
      plugins: [
        {
          modelIdNormalization: {
            providers: {
              myproxy: { aliases: { latest: "modern-model" }, prefixWhenBare: "vendor" },
            },
          },
        },
      ],
    } as unknown as PluginMetadataSnapshot;
    storedConfig = {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            models: [
              {
                id: "vendor/modern-model",
                name: "Before",
                contextWindow: 200_000,
                maxTokens: 8192,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: false,
              },
            ],
          },
        },
      },
    };

    const harness = await invokeConfigPatch({
      raw: {
        models: {
          providers: {
            myproxy: { models: [{ id: "latest", name: "After" }] },
          },
        },
      },
      baseHash: storedHash,
    });

    expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(storedConfig.models?.providers?.myproxy?.models).toHaveLength(1);
    expect(storedConfig.models?.providers?.myproxy?.models?.[0]).toMatchObject({
      id: "vendor/modern-model",
      name: "After",
    });
  });

  it("normalizes model identities before map and ID-keyed array merges", async () => {
    const canonical = "google/gemini-3.1-pro-preview";
    storedConfig = {
      agents: { defaults: { models: { [canonical]: { alias: "Gemini" } } } },
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "gemini-3.1-pro-preview",
                name: "Gemini before",
                contextWindow: 1_048_576,
                maxTokens: 65_536,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: true,
              },
            ],
          },
        },
      },
    };

    const harness = await invokeConfigPatch({
      raw: {
        agents: {
          defaults: { models: { "google/gemini-3-pro-preview": null } },
        },
        models: {
          providers: {
            google: {
              models: [{ id: "gemini-3-pro-preview", name: "Gemini after" }],
            },
          },
        },
      },
      baseHash: storedHash,
    });

    expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(storedConfig.agents?.defaults?.models).toEqual({});
    expect(storedConfig.models?.providers?.google?.models).toHaveLength(1);
    expect(storedConfig.models?.providers?.google?.models?.[0]).toMatchObject({
      id: "gemini-3.1-pro-preview",
      name: "Gemini after",
    });
  });

  it("canonicalizes newly submitted nested model refs before persistence", async () => {
    storedConfig = { gateway: { port: 18789 } };
    const retired = "google/gemini-3-pro-preview";
    const canonical = "google/gemini-3.1-pro-preview";

    const harness = await invokeConfigPatch({
      raw: {
        agents: {
          defaults: {
            model: { primary: retired, fallbacks: [retired] },
            utilityModel: retired,
            imageModel: retired,
            voiceModel: retired,
            pdfModel: retired,
            mediaModels: {
              image: retired,
              video: { primary: retired, fallbacks: [retired] },
              music: retired,
            },
            heartbeat: { model: retired },
            subagents: { model: retired },
            compaction: { model: retired, memoryFlush: { model: retired } },
            models: { [retired]: { alias: "Gemini" } },
          },
          entries: {
            ops: {
              model: retired,
              utilityModel: retired,
              subagents: { model: retired },
              models: { [retired]: { alias: "Ops Gemini" } },
            },
          },
        },
        models: {
          providers: {
            google: {
              api: "google-generative-ai",
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                {
                  id: "gemini-3-pro-preview",
                  name: "Gemini 3 Pro",
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  reasoning: true,
                },
              ],
            },
          },
        },
      },
      baseHash: storedHash,
    });

    expect(harness.respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(storedConfig.agents?.defaults).toMatchObject({
      model: { primary: canonical, fallbacks: [canonical] },
      utilityModel: canonical,
      imageModel: canonical,
      voiceModel: canonical,
      pdfModel: canonical,
      mediaModels: {
        image: canonical,
        video: { primary: canonical, fallbacks: [canonical] },
        music: canonical,
      },
      heartbeat: { model: canonical },
      subagents: { model: canonical },
      compaction: { model: canonical, memoryFlush: { model: canonical } },
      models: { [canonical]: { alias: "Gemini" } },
    });
    expect(storedConfig.agents?.entries?.ops).toMatchObject({
      model: canonical,
      utilityModel: canonical,
      subagents: { model: canonical },
      models: { [canonical]: { alias: "Ops Gemini" } },
    });
    expect(storedConfig.models?.providers?.google?.models?.[0]?.id).toBe("gemini-3.1-pro-preview");
  });
});

/**
 * Tests for config gateway methods, writes, validation, and auth transitions.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import {
  resetConfigRuntimeState,
  setAppliedRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
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

// Hoisted like `configWriteMocks` so individual tests can steer validation results; the
// identity defaults live in the top-level `beforeEach`.
const configValidationMocks = vi.hoisted(() => ({
  validateConfigObjectRawWithPlugins: vi.fn(),
  validateConfigObjectWithPlugins: vi.fn(),
}));

// This suite owns config patch/merge behavior, while plugin validation is covered by
// config.plugin-validation.test.ts and validation.channel-metadata.test.ts.
vi.mock("../../config/validation.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/validation.js")>(
    "../../config/validation.js",
  );
  return {
    ...actual,
    validateConfigObjectRawWithPlugins: configValidationMocks.validateConfigObjectRawWithPlugins,
    validateConfigObjectWithPlugins: configValidationMocks.validateConfigObjectWithPlugins,
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

const {
  execOpenPathMock,
  loadGatewayRuntimeConfigSchemaMock,
  buildRuntimeConfigSchemaForConfigMock,
} = vi.hoisted(() => ({
  execOpenPathMock: vi.fn(),
  loadGatewayRuntimeConfigSchemaMock: vi.fn(() => ({
    schema: { type: "object" },
    uiHints: undefined as Record<string, { advanced?: boolean }> | undefined,
    version: "test-schema",
  })),
  buildRuntimeConfigSchemaForConfigMock: vi.fn((_config?: unknown, _sourceConfig?: unknown) => ({
    schema: { type: "object" },
    uiHints: undefined as
      | Record<string, { advanced?: boolean; sensitive?: boolean; tags?: string[] }>
      | undefined,
    version: "test-schema",
  })),
}));

vi.mock("./open-path.js", async () => {
  const actual = await vi.importActual<typeof import("./open-path.js")>("./open-path.js");
  return { ...actual, execOpenPath: execOpenPathMock };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
  // Write acknowledgements build redaction hints from the committed config, so the mock must
  // answer for an exact config the same way it answers for the active one.
  buildRuntimeConfigSchemaForConfig: buildRuntimeConfigSchemaForConfigMock,
}));

function mockOpenPathError(error: Error) {
  execOpenPathMock.mockRejectedValue(error);
}

let storedConfig: OpenClawConfig;
// Set only where the authored and runtime halves must differ, as they do once auto-enable has
// materialized a selection the operator never wrote. This overrides `sourceConfig` alone and
// leaves `parsed`, `resolved` and `runtimeConfig` aliased to `storedConfig`, which production
// never produces. `config.patch` reads none of them; a `config.set`/`config.apply` test that sets
// this would be reasoning about an impossible snapshot and needs those aliases split first.
let storedSourceConfig: OpenClawConfig | undefined;
let storedHash: string;
let nextHash: number;
let modelNormalizationPluginMetadata: PluginMetadataSnapshot | undefined;

function currentWriteSnapshot() {
  const result = createConfigWriteSnapshot(storedConfig);
  result.snapshot.hash = storedHash;
  result.snapshot.raw = JSON.stringify(storedConfig);
  if (storedSourceConfig) {
    result.snapshot.sourceConfig = storedSourceConfig;
  }
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

async function invokeConfigSet(args: { raw: unknown; baseHash?: string }) {
  const harness = createConfigHandlerHarness({
    method: "config.set",
    params: {
      raw: JSON.stringify(args.raw),
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
    },
  });
  await expectDefined(
    configHandlers["config.set"],
    'configHandlers["config.set"] test invariant',
  )(harness.options);
  return harness;
}

async function invokeConfigApply(args: { raw: unknown; baseHash?: string }) {
  const harness = createConfigHandlerHarness({
    method: "config.apply",
    params: {
      raw: JSON.stringify(args.raw),
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
    },
  });
  await expectDefined(
    configHandlers["config.apply"],
    'configHandlers["config.apply"] test invariant',
  )(harness.options);
  return harness;
}

async function invokeConfigGet() {
  const harness = createConfigHandlerHarness({ method: "config.get" });
  await expectDefined(
    configHandlers["config.get"],
    'configHandlers["config.get"] test invariant',
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
  storedSourceConfig = undefined;
  storedHash = "base-hash";
  nextHash = 1;
  modelNormalizationPluginMetadata = undefined;
  configValidationMocks.validateConfigObjectRawWithPlugins.mockImplementation(
    (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
  );
  configValidationMocks.validateConfigObjectWithPlugins.mockImplementation(
    (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
  );
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

describe("write acknowledgement redaction", () => {
  // A write that REMOVES a claimant drops that claimant's hints from the committed schema, but a
  // value it declared sensitive can survive under a shared channel. Redacting under the committed
  // schema alone would hand that retained secret back in the acknowledgement.
  it("redacts a field whose only sensitive hint belonged to a claimant this write removed", async () => {
    storedConfig = { ui: { prefs: { theme: "claw" } } };
    // Key the schema off the config it is handed, not call order: the pre-write config still has
    // the departing claimant (theme "claw") and is the only side marking the field sensitive; the
    // committed config (theme "lobster") no longer has that claimant, so it reports no hints.
    buildRuntimeConfigSchemaForConfigMock.mockImplementation((config: unknown) => {
      const theme = (config as { ui?: { prefs?: { theme?: string } } } | undefined)?.ui?.prefs
        ?.theme;
      const uiHints: Record<string, { sensitive?: boolean }> =
        theme === "claw" ? { "ui.prefs.theme": { sensitive: true } } : {};
      return { schema: { type: "object" }, uiHints, version: "test-schema" };
    });

    const harness = await invokeConfigPatch({ raw: { ui: { prefs: { theme: "lobster" } } } });

    const lastCall = expectDefined(harness.respond.mock.calls.at(-1), "config.patch respond call");
    const payload = lastCall[1] as { config: { ui: { prefs: { theme: string } } } };
    expect(payload.config.ui.prefs.theme).toBe("__OPENCLAW_REDACTED__");
  });

  // config.set must reach the same answer as config.patch. Its pre-write hints once came from the
  // schema cache, which is keyed on plugin registry version alone; ownership can change through a
  // config reload without touching that key, leaving the cache describing the previous claimant and
  // dropping the only hint that marks the retained value sensitive.
  it("redacts that field on config.set too, with the schema cache describing the old claimant", async () => {
    storedConfig = { ui: { prefs: { theme: "claw" } } };
    buildRuntimeConfigSchemaForConfigMock.mockImplementation((config: unknown) => {
      const theme = (config as { ui?: { prefs?: { theme?: string } } } | undefined)?.ui?.prefs
        ?.theme;
      const uiHints: Record<string, { sensitive?: boolean }> =
        theme === "claw" ? { "ui.prefs.theme": { sensitive: true } } : {};
      return { schema: { type: "object" }, uiHints, version: "test-schema" };
    });
    // The cached schema knows nothing about the departing claimant's field.
    loadGatewayRuntimeConfigSchemaMock.mockReturnValue({
      schema: { type: "object" },
      uiHints: {},
      version: "test-schema",
    });

    const harness = await invokeConfigSet({
      raw: { ui: { prefs: { theme: "lobster" } } },
      baseHash: storedHash,
    });

    const lastCall = expectDefined(harness.respond.mock.calls.at(-1), "config.set respond call");
    const payload = lastCall[1] as { config: { ui: { prefs: { theme: string } } } };
    expect(payload.config.ui.prefs.theme).toBe("__OPENCLAW_REDACTED__");
  });
});

describe("request-scoped schema build memoization", () => {
  // The write RPCs read hints for the pre-write config at more than one site (sentinel restore,
  // the noop ack, the acknowledgement union), and every one of those sites reads the same
  // snapshot object. One build per distinct config object must serve all of them; the committed
  // config is a different object and must always build on its own.
  function captureWriteSnapshotConfig() {
    const captured: { config?: OpenClawConfig; sourceConfig?: OpenClawConfig } = {};
    configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
      const result = currentWriteSnapshot();
      // The real snapshot's authored half is a distinct object from its runtime half; mirror
      // that so the assertions below can tell which half each build received.
      result.snapshot.sourceConfig = structuredClone(result.snapshot.sourceConfig);
      captured.config = result.snapshot.config;
      captured.sourceConfig = result.snapshot.sourceConfig;
      return result;
    });
    return captured;
  }

  it("config.set builds once for the pre-write config and once for the committed config", async () => {
    storedConfig = { ui: { prefs: { theme: "claw" } } };
    const captured = captureWriteSnapshotConfig();

    const { respond } = await invokeConfigSet({
      raw: { ui: { prefs: { theme: "lobster" } } },
      baseHash: storedHash,
    });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    expect(buildRuntimeConfigSchemaForConfigMock).toHaveBeenCalledTimes(2);
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[0]?.[0]).toBe(captured.config);
    // Ownership reads explicit selection from the authored half, never the runtime-shaped one.
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[0]?.[1]).toBe(captured.sourceConfig);
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[1]?.[0]).toBe(storedConfig);
    // The committed config is authored as persisted, so it is its own source half.
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[1]?.[1]).toBe(storedConfig);
  });

  it("config.patch builds once for the pre-write config across restore and acknowledgement", async () => {
    storedConfig = { ui: { prefs: { theme: "claw" } } };
    const captured = captureWriteSnapshotConfig();

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "lobster" } } },
      baseHash: storedHash,
    });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    expect(buildRuntimeConfigSchemaForConfigMock).toHaveBeenCalledTimes(2);
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[0]?.[0]).toBe(captured.config);
    // Ownership reads explicit selection from the authored half, never the runtime-shaped one.
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[0]?.[1]).toBe(captured.sourceConfig);
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[1]?.[0]).toBe(storedConfig);
    // The committed config is authored as persisted, so it is its own source half.
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[1]?.[1]).toBe(storedConfig);
  });

  it("config.apply builds once for the pre-write config across restore and acknowledgement", async () => {
    storedConfig = { ui: { prefs: { theme: "claw" } } };
    const captured = captureWriteSnapshotConfig();

    const { respond } = await invokeConfigApply({
      raw: { ui: { prefs: { theme: "lobster" } } },
      baseHash: storedHash,
    });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    expect(buildRuntimeConfigSchemaForConfigMock).toHaveBeenCalledTimes(2);
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[0]?.[0]).toBe(captured.config);
    // Ownership reads explicit selection from the authored half, never the runtime-shaped one.
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[0]?.[1]).toBe(captured.sourceConfig);
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[1]?.[0]).toBe(storedConfig);
    // The committed config is authored as persisted, so it is its own source half.
    expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[1]?.[1]).toBe(storedConfig);
  });

  it("config.get builds hints at most once per request", async () => {
    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: "/tmp/openclaw-schema-memo-missing/openclaw.json",
        OPENCLAW_STATE_DIR: "/tmp/openclaw-schema-memo-missing/state",
      },
      async () => {
        const { respond } = await invokeConfigGet();

        expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect(buildRuntimeConfigSchemaForConfigMock).toHaveBeenCalledTimes(1);
        // config.get hands the snapshot's authored sourceConfig, its own authored counterpart.
        expect(buildRuntimeConfigSchemaForConfigMock.mock.calls[0]?.[1]).toBe(
          buildRuntimeConfigSchemaForConfigMock.mock.calls[0]?.[0],
        );
      },
    );
  });

  // Pins the memo to object IDENTITY. A write can commit a config whose content equals the
  // pre-write one while ownership must still be derived from the exact object the runtime hands
  // over; a content- or hash-keyed cache would serve the pre-write build for the committed object
  // and recreate the stale-owner redaction defect the per-config builds exist to prevent.
  it("still builds separately for two distinct config objects with identical content", async () => {
    storedConfig = { ui: { prefs: { theme: "claw" } } };
    const captured = captureWriteSnapshotConfig();
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
        // Clone so the committed config is a distinct object with identical content.
        storedConfig = structuredClone(nextConfig);
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

    const { respond } = await invokeConfigSet({
      raw: { ui: { prefs: { theme: "claw" } } },
      baseHash: storedHash,
    });

    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    expect(buildRuntimeConfigSchemaForConfigMock).toHaveBeenCalledTimes(2);
    const builtConfigs = buildRuntimeConfigSchemaForConfigMock.mock.calls;
    expect(builtConfigs[0]?.[0]).toBe(captured.config);
    expect(builtConfigs[0]?.[1]).toBe(captured.sourceConfig);
    expect(builtConfigs[1]?.[0]).toBe(storedConfig);
    expect(builtConfigs[1]?.[1]).toBe(storedConfig);
    expect(builtConfigs[1]?.[0]).not.toBe(builtConfigs[0]?.[0]);
    expect(builtConfigs[1]?.[0]).toEqual(builtConfigs[0]?.[0]);
  });
});

describe("config.set authored submission", () => {
  // Codex P1 3868462615. `config.set`/`config.apply` build their candidate by merging the
  // operator's submission onto the RUNTIME-shaped snapshot, then persist that merge. When the
  // operator hand-writes a selection auto-enable already materialized, `createMergePatch` sees the
  // leaf already present on the runtime half and omits it, and `projectSourceOntoRuntimeShape`
  // walks authored keys only, so it is never reintroduced. The write reported ok while the
  // selection never reached disk -- and the next validation, reading no explicit selection, leaves
  // the declared replacement in charge.
  it("keeps an explicit selection the runtime half had already materialized", async () => {
    const authored = { channels: { zzsel: { token: "t" } } } as unknown as OpenClawConfig;
    const runtime = {
      channels: { zzsel: { token: "t" } },
      plugins: { entries: { "zzsel-plugin": { enabled: true } } },
    } as unknown as OpenClawConfig;
    storedConfig = runtime;
    configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
      const result = createConfigWriteSnapshot(runtime);
      result.snapshot.sourceConfig = authored;
      result.snapshot.resolved = authored;
      result.snapshot.hash = storedHash;
      result.snapshot.raw = JSON.stringify(authored);
      return result;
    });

    await invokeConfigSet({
      raw: {
        channels: { zzsel: { token: "t" } },
        plugins: { entries: { "zzsel-plugin": { enabled: true } } },
      },
      baseHash: storedHash,
    });

    const written = storedConfig as {
      plugins?: { entries?: Record<string, { enabled?: boolean }> };
    };
    expect(written.plugins?.entries?.["zzsel-plugin"]?.enabled).toBe(true);
  });
});

describe("config schema response cache", () => {
  // Tests below publish and clear the process-wide runtime snapshot; drop that module state so
  // later suites keep the unpublished default this file starts from.
  afterEach(() => {
    resetConfigRuntimeState();
  });

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
    // A gateway serving RPCs always has a published runtime snapshot: startup publishes one before
    // the request runtime exists, and a real schema build repins one through
    // `loadPinnedRuntimeConfig` whenever it is missing. The cache proves a hit against that
    // snapshot's identity, so the burst runs with one published, the way every live burst does.
    setAppliedRuntimeConfigSnapshot(storedConfig, storedConfig);
    await invokeConfigSchema();
    await invokeConfigSchema();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(1);
  });

  it("rebuilds every request while no runtime snapshot is published", async () => {
    // No published snapshot means there is no identity to prove a hit against, so the cache must
    // refuse to serve: a pre-clear entry could describe a config the next disk load replaces. In a
    // live gateway the first build ends that window by repinning a snapshot; the mocked builder
    // never repins, so both requests stay inside the window and each one must rebuild.
    resetConfigRuntimeState();
    await invokeConfigSchema();
    await invokeConfigSchema();

    expect(loadGatewayRuntimeConfigSchemaMock).toHaveBeenCalledTimes(2);
  });

  it("rebuilds after config writes change schema inputs", async () => {
    // A serving gateway always has a published runtime snapshot, and config.patch reads the active
    // runtime schema to redact its acknowledgement. Publishing one here keeps that read a cache hit
    // -- as it is in production -- so the counts below still measure what this case is about: the
    // write invalidating the cache for the NEXT request.
    setAppliedRuntimeConfigSnapshot(storedConfig, storedConfig);
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

describe("config.patch authored validation half", () => {
  // Codex P1 3846202592: config.patch validates a merge into the runtime-shaped
  // `snapshot.config`, which carries the `plugins.entries.<id>.config` records validation seeded
  // on the previous pass. Channel schema ownership inside validation reads explicit selection
  // from its authored half, so the handler must hand validation the same patch applied to the
  // AUTHORED snapshot — otherwise the seeds masquerade as operator selection, `preferOver` is set
  // aside, and the config is validated against a schema startup never serves.
  it("hands validation the patch applied to the authored snapshot, not the runtime one", async () => {
    storedConfig = {
      channels: { voxchat: { botToken: "tok" } },
      // Runtime-shaped: the seeded entry the operator never wrote.
      plugins: { entries: { "voxchat-classic": { config: {} } } },
    } as OpenClawConfig;
    const authored = {
      channels: { voxchat: { botToken: "tok" } },
      plugins: {},
    } as OpenClawConfig;
    configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
      const result = currentWriteSnapshot();
      result.snapshot.sourceConfig = authored;
      return result;
    });

    const { respond } = await invokeConfigPatch({
      raw: { channels: { voxchat: { replyMode: "thread" } } },
      baseHash: "base-hash",
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ hash: "next-hash-1" }),
      undefined,
    );
    const expectedSourceConfig = {
      channels: { voxchat: { botToken: "tok", replyMode: "thread" } },
      plugins: {},
    };
    for (const validate of [
      configValidationMocks.validateConfigObjectRawWithPlugins,
      configValidationMocks.validateConfigObjectWithPlugins,
    ]) {
      const call = validate.mock.calls[0];
      // The candidate really is the runtime-shaped merge — the two halves must differ in exactly
      // the seeded entry, or this test would pass with the halves swapped.
      expect(call?.[0]).toEqual({
        channels: { voxchat: { botToken: "tok", replyMode: "thread" } },
        plugins: { entries: { "voxchat-classic": { config: {} } } },
      });
      expect(call?.[1]).toEqual({ sourceConfig: expectedSourceConfig });
    }
  });

  // Codex review P1 on #128904: an edit can move ownership while leaving the materialized config
  // byte-identical. Here the operator hand-selects a plugin auto-enable had already materialized as
  // enabled, so both no-op checks — which compared runtime shapes only — saw no change and the RPC
  // reported success without ever writing the authored selection. Explicit selection is exactly
  // what sets a replacement's `preferOver` aside, so dropping it silently changes channel ownership.
  it("persists a source-only selection the materialized config already reflects", async () => {
    storedConfig = {
      plugins: { entries: { "voxchat-classic": { enabled: true } } },
    } as OpenClawConfig;
    // Authored: the operator never wrote the entry; auto-enable materialized it.
    const authored = { plugins: {} } as OpenClawConfig;
    configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
      const result = currentWriteSnapshot();
      result.snapshot.sourceConfig = authored;
      return result;
    });

    const { respond } = await invokeConfigPatch({
      raw: { plugins: { entries: { "voxchat-classic": { enabled: true } } } },
      baseHash: "base-hash",
    });

    expect(respond).not.toHaveBeenCalledWith(
      true,
      expect.objectContaining({ noop: true }),
      undefined,
    );
    expect(configWriteMocks.commitGatewayConfigWrite).toHaveBeenCalled();
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

/**
 * Tests how config methods build redaction hints: which config object each schema build is keyed
 * on, and how many builds one request may perform. Split from config.test.ts, which owns
 * patch/merge behavior.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
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

const { loadGatewayRuntimeConfigSchemaMock, buildRuntimeConfigSchemaForConfigMock } = vi.hoisted(
  () => ({
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
  }),
);

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
  // Write acknowledgements build redaction hints from the committed config, so the mock must
  // answer for an exact config the same way it answers for the active one.
  buildRuntimeConfigSchemaForConfig: buildRuntimeConfigSchemaForConfigMock,
}));

let storedConfig: OpenClawConfig;
let storedHash: string;
let nextHash: number;

function currentWriteSnapshot() {
  const result = createConfigWriteSnapshot(storedConfig);
  result.snapshot.hash = storedHash;
  result.snapshot.raw = JSON.stringify(storedConfig);
  return result;
}

async function invokeConfigPatch(args: { raw: unknown; baseHash?: string }) {
  const harness = createConfigHandlerHarness({
    method: "config.patch",
    params: {
      raw: JSON.stringify(args.raw),
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
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

beforeEach(() => {
  storedConfig = {};
  storedHash = "base-hash";
  nextHash = 1;
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

afterEach(() => {
  clearConfigSchemaResponseCacheForTests();
  resetPluginRuntimeStateForTest();
  vi.clearAllMocks();
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

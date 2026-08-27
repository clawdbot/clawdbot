/**
 * Tests the hash-free (`baseHash`-less) config.patch path: which changed paths force a base hash.
 *
 * Split out of config.test.ts, which is at its max-lines limit.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
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
  buildRuntimeConfigSchemaForConfig: buildRuntimeConfigSchemaForConfigMock,
}));

let storedConfig: OpenClawConfig;
// Set only where the authored and runtime halves must differ, as they do once auto-enable has
// materialized a selection the operator never wrote, or `materializeRuntimeConfig` applied a
// default. This overrides `sourceConfig` alone and leaves `parsed`, `resolved` and `runtimeConfig`
// aliased to `storedConfig`, which production never produces. `config.patch` reads none of them; a
// `config.set`/`config.apply` test that set this would be reasoning about an impossible snapshot.
let storedSourceConfig: OpenClawConfig | undefined;
let storedHash: string;
let nextHash: number;

function currentWriteSnapshot() {
  const result = createConfigWriteSnapshot(storedConfig);
  result.snapshot.hash = storedHash;
  result.snapshot.raw = JSON.stringify(storedConfig);
  if (storedSourceConfig) {
    result.snapshot.sourceConfig = storedSourceConfig;
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

beforeEach(() => {
  storedConfig = {};
  storedSourceConfig = undefined;
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
  vi.useRealTimers();
  clearConfigSchemaResponseCacheForTests();
  resetPluginRuntimeStateForTest();
  vi.clearAllMocks();
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

  // Codex P2 3871323196: the hashless guard read only the runtime diff. Once auto-enable has
  // materialized `plugins.entries.<id>.enabled` into the runtime config, a patch setting that same
  // leaf changes nothing there, so the guarded list came back empty and `every` accepted it. The
  // authored half is where the change shows, and it is also what keeps the no-op return from
  // firing, so the write landed: a request with no base hash could move explicit plugin selection,
  // and with it channel ownership, outside the one subtree the hashless path may touch.
  it("rejects a hash-free patch that changes only the authored half", async () => {
    storedConfig = { plugins: { entries: { "zz-chat": { enabled: true } } } };
    storedSourceConfig = {};

    const { respond } = await invokeConfigPatch({
      raw: { plugins: { entries: { "zz-chat": { enabled: true } } } },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config base hash required for plugins.entries"),
      }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  // The guard reads the UNFILTERED authored diff. Narrowing it to ownership paths, as the no-op
  // reasoning below does, would leave the same escape open one key over: `materializeRuntimeConfig`
  // applies defaults into the runtime half only, so a patch restating one of them is invisible to
  // the runtime diff, and a `ui.prefs` leaf in the same request defeats the no-op return.
  it("rejects a hash-free patch whose authored-only change is outside plugins and channels", async () => {
    storedConfig = { ui: { prefs: { theme: "claw" } }, gateway: { port: 19_001 } };
    storedSourceConfig = { ui: { prefs: { theme: "claw" } } };

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "knot" } }, gateway: { port: 19_001 } },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("config base hash required for gateway.port"),
      }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
  });

  // The same escape at its worst. The operator wrote a reference; the runtime half holds what it
  // resolved to. Sentinels restore against the runtime half by design, so echoing the public
  // sentinel back would persist the resolved plaintext into the authored file -- from a caller
  // that never learned the secret and supplied no base hash.
  it("rejects a hash-free patch that would resolve a secret reference into the authored file", async () => {
    storedConfig = {
      ui: { prefs: { theme: "claw" } },
      gateway: { auth: { token: "resolved-plaintext-abc123" } },
    } as OpenClawConfig;
    storedSourceConfig = {
      ui: { prefs: { theme: "claw" } },
      gateway: { auth: { token: "${env:OPENCLAW_GATEWAY_TOKEN}" } },
    } as OpenClawConfig;

    const { respond } = await invokeConfigPatch({
      raw: {
        ui: { prefs: { theme: "knot" } },
        gateway: { auth: { token: "__OPENCLAW_REDACTED__" } },
      },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("config base hash required") }),
    );
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
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

  // The post-validation noop is the one response built while both halves are in hand and
  // distinct: the patch changed a leaf (so the pre-validation noop cannot fire), and validation
  // normalized that leaf away (so the post-validation path diff is empty). Its hint build must
  // receive the AUTHORED candidate as the source half — handing it the validated config would
  // read validation's runtime-materialized output, whose seeded entry configs masquerade as
  // operator selection, the exact defect the sourceConfig threading closes.
  it("builds post-validation noop hints from the authored candidate, not the validated config", async () => {
    storedConfig = { ui: { prefs: { theme: "knot" } } };
    const validatedEcho = structuredClone(storedConfig);
    configValidationMocks.validateConfigObjectWithPlugins.mockImplementationOnce(() => ({
      ok: true,
      config: validatedEcho,
      warnings: [],
    }));

    const { respond } = await invokeConfigPatch({
      raw: { ui: { prefs: { theme: "zigzag" } } },
      baseHash: "base-hash",
    });

    // Reached the POST-validation noop: no write, and validation ran exactly once.
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ noop: true }), undefined);
    expect(configWriteMocks.commitGatewayConfigWrite).not.toHaveBeenCalled();
    expect(configValidationMocks.validateConfigObjectWithPlugins).toHaveBeenCalledTimes(1);
    const validationInput =
      configValidationMocks.validateConfigObjectWithPlugins.mock.calls[0]?.[0];
    const authoredInput = (
      configValidationMocks.validateConfigObjectWithPlugins.mock.calls[0]?.[1] as
        | { sourceConfig?: unknown }
        | undefined
    )?.sourceConfig;
    const noopBuild = buildRuntimeConfigSchemaForConfigMock.mock.calls.at(-1);
    expect(noopBuild?.[0]).toBe(validatedEcho);
    // The source half is the authored config — never validation's output, and never the
    // runtime-shaped candidate validation reads, which carries validation-seeded entry configs.
    expect(noopBuild?.[1]).toEqual(authoredInput);
    expect(noopBuild?.[1]).not.toBe(validatedEcho);
    expect(noopBuild?.[1]).not.toBe(validationInput);
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

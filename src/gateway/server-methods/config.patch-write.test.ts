/**
 * Tests which config.patch persists: the authored config, not the runtime-shaped validation input.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { clearConfigSchemaResponseCacheForTests, configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const REDACTED = "__OPENCLAW_REDACTED__";

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
    loadGatewayRuntimeConfigSchemaMock: vi.fn(),
    buildRuntimeConfigSchemaForConfigMock: vi.fn(),
  }),
);

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: loadGatewayRuntimeConfigSchemaMock,
  buildRuntimeConfigSchemaForConfig: buildRuntimeConfigSchemaForConfigMock,
}));

let runtimeConfig: OpenClawConfig;
let authoredConfig: OpenClawConfig;

function schemaResponse(uiHints: Record<string, { sensitive?: boolean }>) {
  return { schema: { type: "object" }, uiHints, version: "test-schema" };
}

/** Persists the config the handler actually handed the write flow. */
function persistedConfig(): OpenClawConfig {
  const call = expectDefined(
    configWriteMocks.commitGatewayConfigWrite.mock.calls.at(-1),
    "commitGatewayConfigWrite call",
  );
  return (call[0] as { nextConfig: OpenClawConfig }).nextConfig;
}

async function invokeConfigPatch(raw: unknown) {
  const harness = createConfigHandlerHarness({
    method: "config.patch",
    params: { raw: JSON.stringify(raw), baseHash: "base-hash" },
  });
  await expectDefined(
    configHandlers["config.patch"],
    'configHandlers["config.patch"] test invariant',
  )(harness.options);
  return harness;
}

beforeEach(() => {
  loadGatewayRuntimeConfigSchemaMock.mockReturnValue(schemaResponse({}));
  buildRuntimeConfigSchemaForConfigMock.mockReturnValue(schemaResponse({}));
  configValidationMocks.validateConfigObjectRawWithPlugins.mockImplementation(
    (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
  );
  configValidationMocks.validateConfigObjectWithPlugins.mockImplementation(
    (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
  );
  configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
    const result = createConfigWriteSnapshot(runtimeConfig);
    result.snapshot.hash = "base-hash";
    result.snapshot.raw = JSON.stringify(runtimeConfig);
    // The authored half is what the operator's file holds; the runtime half carries what
    // validation and auto-enable materialized on top of it.
    result.snapshot.sourceConfig = authoredConfig;
    return result;
  });
  configWriteMocks.commitGatewayConfigWrite.mockImplementation(
    async ({ nextConfig }: { nextConfig: OpenClawConfig }) => ({
      path: "/tmp/openclaw.json",
      config: nextConfig,
      hash: "next-hash",
      queueFollowUp: vi.fn(),
    }),
  );
});

afterEach(() => {
  clearConfigSchemaResponseCacheForTests();
  resetPluginRuntimeStateForTest();
  vi.clearAllMocks();
});

describe("config.patch persists the authored config", () => {
  // Codex review P1 on #128904: the patch is merged onto the runtime-shaped `snapshot.config` for
  // validation, and that same merge was handed to the write flow. Validation seeds
  // `plugins.entries.<id>.config` for every enabled claimant, so the write put a record in the
  // authored file the operator never wrote — and explicit selection is exactly what sets a
  // declared `preferOver` aside, so the next load moves the channel to a different plugin.
  it("does not write a validation-seeded plugin entry the operator never authored", async () => {
    runtimeConfig = {
      channels: { voxchat: { replyMode: "inline" } },
      plugins: { entries: { "voxchat-classic": { config: {} } } },
    } as unknown as OpenClawConfig;
    authoredConfig = {
      channels: { voxchat: { replyMode: "inline" } },
      plugins: {},
    } as OpenClawConfig;

    await invokeConfigPatch({ channels: { voxchat: { replyMode: "thread" } } });

    const written = persistedConfig() as {
      channels?: { voxchat?: { replyMode?: string } };
      plugins?: { entries?: Record<string, unknown> };
    };
    // The operator's own edit still lands.
    expect(written.channels?.voxchat?.replyMode).toBe("thread");
    expect(written.plugins?.entries).toBeUndefined();
  });

  // Guards the hazard the fix above introduces if the authored merge is persisted raw: the Control
  // UI echoes `__OPENCLAW_REDACTED__` back for a sensitive value, and only the runtime half holds
  // the real one when it is materialized from a default, an env var or a secret ref. Writing the
  // authored merge without resolving sentinels against the runtime config would overwrite a live
  // credential with the placeholder.
  it("resolves an echoed sentinel from the runtime config instead of persisting it", async () => {
    runtimeConfig = {
      channels: { voxchat: { botToken: "real-token", replyMode: "inline" } },
    } as unknown as OpenClawConfig;
    // The token is materialized, never authored.
    authoredConfig = {
      channels: { voxchat: { replyMode: "inline" } },
    } as unknown as OpenClawConfig;
    buildRuntimeConfigSchemaForConfigMock.mockReturnValue(
      schemaResponse({ "channels.voxchat.botToken": { sensitive: true } }),
    );

    await invokeConfigPatch({ channels: { voxchat: { botToken: REDACTED, replyMode: "thread" } } });

    const written = persistedConfig() as {
      channels?: { voxchat?: { botToken?: string; replyMode?: string } };
    };
    expect(written.channels?.voxchat?.botToken).toBe("real-token");
    expect(written.channels?.voxchat?.replyMode).toBe("thread");
  });
});

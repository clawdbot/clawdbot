/**
 * Tests that every config write response redacts with at least the hints `config.get` redacted with.
 *
 * `config.get` hides a field using the union of the active runtime owner's hints and the persisted
 * owner's. An ownership-changing edit can drop a claimant from persisted discovery while
 * `gateway.reload.mode="off"` leaves it serving, so that union is strictly wider than the persisted
 * side alone. Two things then have to hold on the way back in: a sentinel the active owner alone
 * explains must still restore, and no acknowledgement may echo the value it stood for. Asserting
 * only the first is what makes this dangerous -- restoring without redacting turns an ordinary
 * round trip into a read oracle for exactly the field that was hidden.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { clearConfigSchemaResponseCacheForTests, configHandlers } from "./config.js";
import { createConfigHandlerHarness, createConfigWriteSnapshot } from "./config.test-helpers.js";

const REDACTED = "__OPENCLAW_REDACTED__";
// Distinctive on purpose: responses embed the config path, so a value like "claw" is a substring
// of "openclaw.json" and a leak assertion built on it would pass whether or not it leaked.
const RETAINED = "kelp-retained-value";

const configWriteMocks = vi.hoisted(() => ({
  readConfigFileSnapshotForWrite: vi.fn(),
  commitGatewayConfigWrite: vi.fn(),
}));

vi.mock("../../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
  return {
    ...actual,
    readConfigFileSnapshotForWrite: configWriteMocks.readConfigFileSnapshotForWrite,
  };
});

// Validation is mocked to identity: this suite is about which hints redact a response, not about
// schema shape, and a real enum check on the carrier field would fail the request before any
// acknowledgement is built. `config.test.ts` mocks it the same way for the same reason.
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

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
    config,
  })),
}));

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

let storedConfig: OpenClawConfig;
let storedHash: string;

beforeEach(() => {
  storedConfig = { ui: { prefs: { theme: RETAINED } } } as unknown as OpenClawConfig;
  storedHash = "base-hash";
  configWriteMocks.commitGatewayConfigWrite.mockImplementation(
    async ({ nextConfig }: { nextConfig: OpenClawConfig }) => {
      storedConfig = nextConfig;
      storedHash = "next-hash";
      return {
        path: "/tmp/openclaw.json",
        config: storedConfig,
        hash: storedHash,
        queueFollowUp: vi.fn(),
      };
    },
  );
  configValidationMocks.validateConfigObjectRawWithPlugins.mockImplementation(
    (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
  );
  configValidationMocks.validateConfigObjectWithPlugins.mockImplementation(
    (config: OpenClawConfig) => ({ ok: true, config, warnings: [] }),
  );
  configWriteMocks.readConfigFileSnapshotForWrite.mockImplementation(async () => {
    const result = createConfigWriteSnapshot(storedConfig);
    result.snapshot.hash = storedHash;
    result.snapshot.raw = JSON.stringify(storedConfig);
    return result;
  });
  // Only the ACTIVE runtime marks the retained field sensitive; the persisted side does not. This
  // is the state an ownership-changing edit leaves behind, and the state config.get redacted in.
  buildRuntimeConfigSchemaForConfigMock.mockReturnValue({
    schema: { type: "object" },
    uiHints: {},
    version: "test-schema",
  });
  loadGatewayRuntimeConfigSchemaMock.mockReturnValue({
    schema: { type: "object" },
    uiHints: { "ui.prefs.theme": { sensitive: true } },
    version: "test-schema",
  });
});

afterEach(() => {
  clearConfigSchemaResponseCacheForTests();
  resetPluginRuntimeStateForTest();
  vi.clearAllMocks();
});

async function invoke(method: "config.set" | "config.patch", raw: unknown) {
  const harness = createConfigHandlerHarness({
    method,
    params: { raw: JSON.stringify(raw), baseHash: storedHash },
  });
  await expectDefined(
    configHandlers[method],
    `configHandlers["${method}"] test invariant`,
  )(harness.options);
  return expectDefined(harness.respond.mock.calls.at(-1), `${method} respond call`);
}

function expectRedactedSuccess(call: unknown[]) {
  expect(call[2]).toBeUndefined();
  expect(call[0]).toBe(true);
  const payload = call[1] as { config?: { ui?: { prefs?: { theme?: string } } } };
  expect(payload.config?.ui?.prefs?.theme).toBe(REDACTED);
  expect(JSON.stringify(payload)).not.toContain(RETAINED);
}

describe("write acknowledgements redact with the restore-side hint union", () => {
  // Submitting the sentinel: it has to restore (or the save is rejected as reserved data) AND the
  // acknowledgement has to redact it again.
  it.each(["config.set", "config.patch"] as const)(
    "%s restores an active-owner-only sentinel without echoing it back",
    async (method) => {
      expectRedactedSuccess(await invoke(method, { ui: { prefs: { theme: REDACTED } } }));
    },
  );

  // No sentinel anywhere in the request, and a real change so the write commits. The commit
  // acknowledgement echoes the stored config, so a hint set narrower than the one config.get
  // redacted with hands the retained value straight back -- no sentinel needs to be submitted for
  // the oracle to work. This is the path through respondWithConfigRestartWrite.
  // config.set replaces the whole config, so the field has to be carried in the submission for the
  // response to echo it at all; it is submitted in the clear, with no sentinel anywhere.
  it("config.set commit response does not echo the retained value when no sentinel is submitted", async () => {
    expectRedactedSuccess(
      await invoke("config.set", { ui: { prefs: { theme: RETAINED, density: "compact" } } }),
    );
  });

  // config.patch merges, so the stored field is echoed by the commit acknowledgement without ever
  // appearing in the request.
  it("config.patch commit response does not echo the retained value when no sentinel is submitted", async () => {
    expectRedactedSuccess(await invoke("config.patch", { ui: { prefs: { density: "compact" } } }));
  });

  // The pre-validation no-op path: an unchanged patch still echoes the stored config.
  it("config.patch pre-validation no-op echoes the stored config redacted", async () => {
    expectRedactedSuccess(await invoke("config.patch", {}));
  });

  // The post-validation no-op path: the patch carries a change that validation normalizes away,
  // so the early no-op does not fire and a second, separate acknowledgement is built.
  it("config.patch post-validation no-op echoes the stored config redacted", async () => {
    configValidationMocks.validateConfigObjectWithPlugins.mockImplementation(() => ({
      ok: true,
      config: structuredClone(storedConfig),
      warnings: [],
    }));

    expectRedactedSuccess(await invoke("config.patch", { ui: { prefs: { density: "compact" } } }));
  });
});

/**
 * Tests config.get redaction against the schema plane that owns each field.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { clearConfigSchemaResponseCacheForTests, configHandlers } from "./config.js";
import { createConfigHandlerHarness } from "./config.test-helpers.js";

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

async function invokeConfigGet() {
  const harness = createConfigHandlerHarness({ method: "config.get" });
  await expectDefined(
    configHandlers["config.get"],
    'configHandlers["config.get"] test invariant',
  )(harness.options);
  return harness;
}

afterEach(() => {
  clearConfigSchemaResponseCacheForTests();
  resetPluginRuntimeStateForTest();
  vi.clearAllMocks();
});

describe("config.get redaction hints", () => {
  // Codex review P1 on #128904: the write acknowledgement unions pre/post hints, but the NEXT
  // config.get rebuilt them from the newly persisted registry alone. An ownership-changing write
  // can drop a claimant from discovery while the value only that claimant marked sensitive stays
  // in the file, and with `gateway.reload.mode=off` the departing claimant is still the runtime
  // serving it. Projecting the persisted side alone returned that value in plaintext whenever the
  // replacement's schema accepts the field without marking it sensitive.
  it("redacts a retained value whose only sensitive hint belongs to the active runtime owner", async () => {
    // The newly persisted registry does not mark the retained field sensitive...
    buildRuntimeConfigSchemaForConfigMock.mockReturnValue({
      schema: { type: "object" },
      uiHints: {},
      version: "test-schema",
    });
    // ...while the active runtime, still serving the departing owner, is the only side that does.
    loadGatewayRuntimeConfigSchemaMock.mockReturnValue({
      schema: { type: "object" },
      uiHints: { "ui.prefs.theme": { sensitive: true } },
      version: "test-schema",
    });

    await withTempDir("openclaw-config-get-hint-union-", async (dir) => {
      const configPath = path.join(dir, "openclaw.json");
      await fs.writeFile(configPath, JSON.stringify({ ui: { prefs: { theme: "claw" } } }), "utf-8");
      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: dir },
        async () => {
          const harness = await invokeConfigGet();

          const lastCall = expectDefined(
            harness.respond.mock.calls.at(-1),
            "config.get respond call",
          );
          const payload = lastCall[1] as { config: { ui?: { prefs?: { theme?: string } } } };
          expect(payload.config.ui?.prefs?.theme).toBe("__OPENCLAW_REDACTED__");
        },
      );
    });
  });

  it("redacts a custom channel secret when its authored key uses capitals", async () => {
    const schema = {
      schema: { type: "object" },
      uiHints: { "channels.acmechat.opaqueCredential": { sensitive: true } },
      version: "test-schema",
    };
    buildRuntimeConfigSchemaForConfigMock.mockReturnValue(schema);
    loadGatewayRuntimeConfigSchemaMock.mockReturnValue(schema);

    await withTempDir("openclaw-config-get-channel-case-", async (dir) => {
      // Discovery needs the manifest to accept AcmeChat into the parsed config snapshot. The mocked
      // runtime schema returns the canonical hint path that this manifest's metadata emits.
      const pluginDir = path.join(dir, "acme-chat");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "acme-chat",
          channels: ["AcmeChat"],
          channelConfigs: {
            AcmeChat: {
              schema: {
                type: "object",
                properties: { opaqueCredential: { type: "string" } },
                additionalProperties: false,
              },
              uiHints: { opaqueCredential: { sensitive: true } },
            },
          },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
        "utf-8",
      );
      await fs.writeFile(path.join(pluginDir, "index.js"), "export default { register() {} };\n");
      const configPath = path.join(dir, "openclaw.json");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          channels: { AcmeChat: { opaqueCredential: "case-secret" } },
          plugins: { load: { paths: [pluginDir] } },
        }),
        "utf-8",
      );
      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: dir },
        async () => {
          const harness = await invokeConfigGet();
          const lastCall = expectDefined(
            harness.respond.mock.calls.at(-1),
            "config.get respond call",
          );
          const payload = lastCall[1] as {
            config: { channels?: { AcmeChat?: { opaqueCredential?: string } } };
            raw?: string | null;
          };

          expect(payload.config.channels?.AcmeChat?.opaqueCredential).toBe("__OPENCLAW_REDACTED__");
          expect(payload.raw).not.toContain("case-secret");
        },
      );
    });
  });
});

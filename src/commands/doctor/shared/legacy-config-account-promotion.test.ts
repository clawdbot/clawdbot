import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../../../plugins/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { seedMissingDefaultAccountsFromSingleAccountBase } from "./legacy-config-core-normalizers.js";

let state: OpenClawTestState | undefined;

afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  await state?.cleanup();
  state = undefined;
});

it.each([
  { enabled: true, configPromotion: "preserve-root" },
  { enabled: false, configPromotion: "preserve-root" },
  { enabled: true, configPromotion: true },
  { enabled: true, configPromotion: false },
  { enabled: true, configPromotion: undefined },
])(
  "honors cold installed plugin promotion metadata without loading runtime: %j",
  async ({ enabled, configPromotion }) => {
    state = await createOpenClawTestState({ label: "doctor-preserved-account", applyEnv: true });
    const pluginDir = state.statePath("extensions", "preserved");
    const bundledDir = state.path("empty-bundled");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(bundledDir, { recursive: true });
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledDir);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      "throw new Error('Doctor must not execute this plugin runtime');\n",
    );
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@example/preserved",
        version: "1.0.0",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
          channel: { id: "preserved-chat" },
          setupFeatures: { configPromotion },
        },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "preserved",
        configSchema: { type: "object" },
        channels: ["preserved-chat"],
        channelConfigs: { "preserved-chat": { schema: { type: "object" } } },
      }),
    );
    // Only generic fields: undeclared-key deferral cannot hide a missing static contract.
    const cfg: OpenClawConfig = {
      plugins: { allow: ["preserved"], entries: { preserved: { enabled } } },
      channels: {
        "preserved-chat": {
          name: "Environment-backed root",
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          accounts: { ada: { name: "Ada" } },
        },
      },
    };
    const before = structuredClone(cfg);
    for (let run = 0; run < 2; run++) {
      clearPluginMetadataLifecycleCaches();
      resetPluginRuntimeStateForTest();
      const changes: string[] = [];
      const result = seedMissingDefaultAccountsFromSingleAccountBase(cfg, changes);
      if (configPromotion === "preserve-root") {
        expect(result).toEqual(before);
        expect(changes).toEqual([]);
      } else {
        expect(result.channels?.["preserved-chat"]).toEqual({
          accounts: {
            default: {
              name: "Environment-backed root",
              groupPolicy: "allowlist",
              groupAllowFrom: [],
            },
            ada: { name: "Ada", groupPolicy: "allowlist", groupAllowFrom: [] },
          },
        });
        expect(changes).toHaveLength(1);
      }
    }
    expect(cfg).toEqual(before);
  },
);

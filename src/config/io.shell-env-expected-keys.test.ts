// Verifies shell environment key metadata used by config IO.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGeneratedPluginTempRoot,
  installGeneratedPluginTempRootCleanup,
  writeJson,
} from "../plugins/generated-plugin-test-helpers.js";
import { createConfigIO } from "./io.js";

const loadShellEnvFallback = vi.hoisted(() =>
  vi.fn<typeof import("../infra/shell-env.js").loadShellEnvFallback>(),
);

vi.mock("../infra/shell-env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/shell-env.js")>()),
  loadShellEnvFallback,
}));

installGeneratedPluginTempRootCleanup();

describe("config io shell env expected keys", () => {
  beforeEach(() => {
    loadShellEnvFallback.mockClear();
  });

  it.each(["loadConfig", "readBestEffortConfig"] as const)(
    "%s includes env keys from a configured plugin without executing its runtime",
    async (read) => {
      const home = createGeneratedPluginTempRoot("openclaw-shell-env-metadata-");
      const pluginDir = path.join(home, "configured-plugin");
      const configPath = path.join(home, "state", "openclaw.json");
      writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
        id: "shell-fixture",
        providers: ["shell-fixture"],
        channels: ["shell-fixture"],
        channelConfigs: { "shell-fixture": { schema: { type: "object" } } },
        setup: {
          requiresRuntime: false,
          providers: [{ id: "shell-fixture", envVars: ["SHELL_FIXTURE_PROVIDER_KEY"] }],
        },
        configSchema: { type: "object", properties: {} },
      });
      writeJson(path.join(pluginDir, "package.json"), {
        name: "shell-fixture",
        version: "1.0.0",
        openclaw: {
          extensions: ["./index.js"],
          channel: {
            id: "shell-fixture",
            configuredState: {
              env: {
                allOf: ["SHELL_FIXTURE_CHANNEL_KEY"],
                anyOf: ["SHELL_FIXTURE_PROVIDER_KEY"],
              },
            },
          },
        },
      });
      fs.writeFileSync(path.join(pluginDir, "index.js"), 'throw new Error("metadata only");\n');
      writeJson(configPath, {
        env: { shellEnv: { enabled: true } },
        plugins: { allow: ["shell-fixture"], load: { paths: [pluginDir] } },
      });
      const env = {
        HOME: home,
        OPENCLAW_STATE_DIR: path.dirname(configPath),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(home, "empty-bundled"),
      };
      fs.mkdirSync(env.OPENCLAW_BUNDLED_PLUGINS_DIR);

      await createConfigIO({ configPath, env, homedir: () => home, observe: false })[read]();

      expect(loadShellEnvFallback).toHaveBeenCalledOnce();
      const { expectedKeys } = loadShellEnvFallback.mock.calls[0]![0];
      expect(expectedKeys.filter((key) => key.startsWith("SHELL_FIXTURE_"))).toEqual([
        "SHELL_FIXTURE_PROVIDER_KEY",
        "SHELL_FIXTURE_CHANNEL_KEY",
      ]);
      expect(expectedKeys).toEqual(
        expect.arrayContaining(["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"]),
      );
    },
  );
});

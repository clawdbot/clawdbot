// Fixture Config tests cover fixture config script behavior.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const fixturePath = path.resolve("scripts/e2e/lib/fixture.mjs");

const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function runFixture(
  root: string,
  command: string,
  args: string[] = [],
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [fixturePath, command, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CONFIG_BATCH_PATH: path.join(root, "batch.json"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_OPENWEBUI_MODEL: "openai/gpt-5.4-mini",
      OPENCLAW_STATE_DIR: root,
      ...env,
    },
  });
}

describe("scripts/e2e/lib/fixture.mjs config commands", () => {
  it.each<[string, string[], Record<string, string>, string]>([
    ["config-reload", [], { PORT: "18789tcp" }, "invalid PORT: 18789tcp"],
    ["config-reload", [], { PORT: "65536" }, "invalid PORT: 65536"],
    ["browser-cdp", [], { CDP_PORT: "19222http" }, "invalid CDP_PORT: 19222http"],
    ["browser-cdp", [], { CDP_PORT: "65536" }, "invalid CDP_PORT: 65536"],
    [
      "openwebui-config",
      ["test-key"],
      { OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS: "300s" },
      "invalid OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS: 300s",
    ],
  ])("rejects %s arguments %j and env %j", (command, args, env, message) => {
    const root = tempRoots.make("openclaw-fixture-config-");
    const result = runFixture(root, command, args, env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it("writes strict positive browser CDP ports into generated config", () => {
    const root = tempRoots.make("openclaw-fixture-config-");
    const result = runFixture(root, "browser-cdp", [], { CDP_PORT: "19223", PORT: "19000" });

    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
    expect(config.gateway.port).toBe(19000);
    expect(config.browser.noSandbox).toBe(true);
    expect(config.browser.extraArgs).toEqual([
      "--remote-debugging-address=127.0.0.1",
      "about:blank",
    ]);
    expect(config.browser.profiles["docker-cdp"].cdpUrl).toBe("http://127.0.0.1:19223");
  });

  it("writes strict positive Open WebUI provider timeouts into generated config", () => {
    const root = tempRoots.make("openclaw-fixture-config-");
    const result = runFixture(root, "openwebui-config", ["test-key"], {
      OPENCLAW_OPENWEBUI_PROVIDER_TIMEOUT_SECONDS: "300",
    });

    expect(result.status).toBe(0);
    const batch = JSON.parse(readFileSync(path.join(root, "batch.json"), "utf8"));
    expect(
      batch.find(
        (entry: { path: string }) => entry.path === "models.providers.openai.timeoutSeconds",
      )?.value,
    ).toBe(300);
  });

  it("writes OpenAI web-search minimal config for the package scenario", () => {
    const root = tempRoots.make("openclaw-fixture-config-");
    const result = runFixture(root, "openai-web-search-minimal-config");

    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
    expect(config.agents.defaults.model.primary).toBe("openai/gpt-5");
    expect(config.models.providers.openai).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      request: { allowPrivateNetwork: true },
    });
    expect(config.tools.web.search).toEqual({ enabled: true, maxResults: 3 });
    expect(config.plugins.entries.openai).toEqual({ enabled: true });
    expect(config.gateway.auth).toEqual({ mode: "token", token: "test-token" });
  });
});

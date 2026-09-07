// The real non-probe models-status route must scope discovery to providers already in use.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";

const testState = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  logs: [] as string[],
}));

vi.mock("./command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
}));

vi.mock("../commands/models/load-config.js", () => ({
  loadModelsConfig: vi.fn(async () => testState.config),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn(),
    log: (value: unknown) => testState.logs.push(String(value)),
    writeJson: (value: unknown) => testState.logs.push(JSON.stringify(value)),
    writeStdout: vi.fn(),
  },
  writeRuntimeJson: vi.fn((runtime: { writeJson: (value: unknown) => void }, value: unknown) =>
    runtime.writeJson(value),
  ),
}));

import { tryRouteCli } from "./route.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-models-status-route-"));

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("does not execute an unrelated provider plugin", async () => {
  const pluginRoot = path.join(tempRoot, "unrelated-provider");
  fs.mkdirSync(pluginRoot, { recursive: true });
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "unrelated-provider",
    providerId: "unrelated-provider",
  });
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
  testState.config = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-sol" },
        models: { "openai/gpt-5.6-sol": {} },
      },
    },
    plugins: {
      load: { paths: [pluginRoot] },
      entries: { "unrelated-provider": { enabled: true } },
    },
  };

  for (const argv of [
    ["node", "openclaw", "models", "status", "--json"],
    ["node", "openclaw", "models", "--json"],
    ["node", "openclaw", "models", "--agent", "main", "--status-json"],
  ]) {
    await expect(tryRouteCli(argv)).resolves.toBe(true);
    const payload = JSON.parse(testState.logs.at(-1) ?? "{}") as { defaultModel?: string };
    expect(payload.defaultModel).toBe("openai/gpt-5.6-sol");
  }
  expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
});

import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({ getRuntimeConfig: loadConfigMock }));

describe("agents/context eager warmup", () => {
  const originalArgv = process.argv.slice();

  beforeEach(() => {
    loadConfigMock.mockReset();
  });

  afterEach(() => {
    process.argv = originalArgv.slice();
  });

  it.each([
    ["models", ["node", "openclaw", "models", "set", "openai/gpt-5.4"]],
    ["agent", ["node", "openclaw", "agent", "--message", "ok"]],
    ["memory", ["node", "openclaw", "memory", "search", "--json"]],
  ])("does not eager-load config for %s commands on import", async (_label, argv) => {
    process.argv = argv;
    await importFreshModule(import.meta.url, `./context.js?scope=${_label}`);

    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});

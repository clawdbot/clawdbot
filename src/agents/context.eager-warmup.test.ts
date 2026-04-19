import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({ loadConfig: loadConfigMock }));

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
  ])("does not eager-load config for %s commands on import", async (_label, argv) => {
    process.argv = argv;
    await importFreshModule(import.meta.url, `./context.js?scope=${_label}`);

    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});

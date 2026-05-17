import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConfigIO: vi.fn().mockReturnValue({
    configPath: "/tmp/openclaw-dev/openclaw.json",
  }),
}));

vi.mock("./io.js", () => ({
  createConfigIO: mocks.createConfigIO,
}));

let formatConfigPath: typeof import("./logging.js").formatConfigPath;
let formatConfigUpdatedMessage: typeof import("./logging.js").formatConfigUpdatedMessage;
let logConfigUpdated: typeof import("./logging.js").logConfigUpdated;

beforeAll(async () => {
  ({ formatConfigPath, formatConfigUpdatedMessage, logConfigUpdated } =
    await import("./logging.js"));
});

beforeEach(() => {
  mocks.createConfigIO.mockClear();
});

describe("config logging", () => {
  it("formats the live config path when no explicit path is provided", () => {
    expect(formatConfigPath()).toBe("/tmp/openclaw-dev/openclaw.json");
  });

  it("logs the live config path when no explicit path is provided", () => {
    const runtime = { log: vi.fn() };
    logConfigUpdated(runtime as never);
    expect(runtime.log).toHaveBeenCalledWith("Updated config: /tmp/openclaw-dev/openclaw.json");
  });

  it("formats backup as an indented detail when present", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-log-"));
    const configPath = path.join(dir, "openclaw.json");
    const backupPath = `${configPath}.bak`;
    fs.writeFileSync(backupPath, "{}", "utf8");

    expect(
      formatConfigUpdatedMessage(configPath, {
        backupPath,
      }),
    ).toBe(`Updated config: ${configPath}\n  Backup: ${backupPath}`);
  });
});

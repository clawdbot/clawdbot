import { describe, expect, it } from "vitest";

import { isMainModule } from "./is-main.js";

describe("isMainModule", () => {
  it("returns true when argv[1] matches current file", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node", "/repo/dist/index.js"],
        cwd: "/repo",
        env: {},
      }),
    ).toBe(true);
  });

  it("returns true under PM2 when pm_exec_path matches current file", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node", "/pm2/lib/ProcessContainerFork.js"],
        cwd: "/repo",
        env: { pm_exec_path: "/repo/dist/index.js", pm_id: "0" },
      }),
    ).toBe(true);
  });

  it("returns false when running under PM2 but this module is imported", () => {
    expect(
      isMainModule({
        currentFile: "/repo/node_modules/moltbot/dist/index.js",
        argv: ["node", "/repo/app.js"],
        cwd: "/repo",
        env: { pm_exec_path: "/repo/app.js", pm_id: "0" },
      }),
    ).toBe(false);
  });
});

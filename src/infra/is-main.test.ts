// Tests module main-entry detection helpers.
import { describe, expect, it, vi } from "vitest";
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

  it("falls back to the current file directory when process.cwd is unavailable", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("uv_cwd"), { code: "ENOENT", syscall: "uv_cwd" });
    });
    try {
      expect(
        isMainModule({
          currentFile: "/repo/dist/index.js",
          argv: ["node", "/repo/dist/index.js"],
          env: {},
        }),
      ).toBe(true);
    } finally {
      cwdSpy.mockRestore();
    }
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

  it("resolves relative pm_exec_path values against cwd", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node", "/pm2/lib/ProcessContainerFork.js"],
        cwd: "/repo",
        env: { pm_exec_path: "./dist/index.js", pm_id: "0" },
      }),
    ).toBe(true);
  });

  it("returns true for configured wrapper-to-entry pairs", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/entry.js",
        argv: ["node", "/repo/openclaw.mjs"],
        cwd: "/repo",
        env: {},
        wrapperEntryPairs: [{ wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" }],
      }),
    ).toBe(true);
  });

  it("returns false for unmatched wrapper launches", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/entry.js",
        argv: ["node", "/repo/openclaw.mjs"],
        cwd: "/repo",
        env: {},
      }),
    ).toBe(false);
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node", "/repo/openclaw.mjs"],
        cwd: "/repo",
        env: {},
        wrapperEntryPairs: [{ wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" }],
      }),
    ).toBe(false);
  });

  it("returns false when this module is only imported under PM2", () => {
    expect(
      isMainModule({
        currentFile: "/repo/node_modules/openclaw/dist/index.js",
        argv: ["node", "/repo/app.js"],
        cwd: "/repo",
        env: { pm_exec_path: "/repo/app.js", pm_id: "0" },
      }),
    ).toBe(false);
  });

  it("returns false for another entrypoint with the same basename", () => {
    expect(
      isMainModule({
        currentFile: "/repo/node_modules/openclaw/dist/index.js",
        argv: ["node", "/repo/dist/index.js"],
        cwd: "/repo",
        env: {},
      }),
    ).toBe(false);
  });

  it("returns false when no entrypoint candidate exists", () => {
    expect(
      isMainModule({
        currentFile: "/repo/dist/index.js",
        argv: ["node"],
        cwd: "/repo",
        env: {},
      }),
    ).toBe(false);
  });
});

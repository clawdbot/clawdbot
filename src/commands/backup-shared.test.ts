import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRequiredBackupPath } from "./backup-shared.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveRequiredBackupPath", () => {
  it.each([
    [undefined, "--repository"],
    ["", "--target"],
    ["   ", "<snapshot>"],
    ["\t", "--scratch"],
  ] as const)("rejects %j for %s", (value, label) => {
    expect(() => resolveRequiredBackupPath(value, label)).toThrow(
      `Missing required ${label} value.`,
    );
  });

  it("trims and resolves relative paths from cwd", () => {
    expect(resolveRequiredBackupPath("  backups/archive  ", "--target")).toBe(
      path.resolve("backups/archive"),
    );
  });

  it("expands tilde from the effective home", () => {
    const home = path.resolve("effective-home");
    vi.stubEnv("OPENCLAW_HOME", home);
    expect(resolveRequiredBackupPath("~/backups", "--repository")).toBe(path.join(home, "backups"));
  });

  it("preserves absolute paths", () => {
    const absolute = path.resolve("absolute-backup");
    expect(resolveRequiredBackupPath(`  ${absolute}  `, "--scratch")).toBe(absolute);
  });
});

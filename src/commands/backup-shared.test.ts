import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBackupPlanFromDisk, resolveRequiredBackupPath } from "./backup-shared.js";

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

describe("resolveBackupPlanFromDisk workspace exclusion", () => {
  it("stops traversing the configured shared workspace base when workspace content is excluded", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-base-"));
    const stateDir = path.join(home, ".openclaw");
    const sharedBase = path.join(stateDir, "workspace");
    await fs.mkdir(path.join(sharedBase, "tmp"), { recursive: true });
    await fs.mkdir(path.join(sharedBase, "main"), { recursive: true });
    await fs.writeFile(path.join(sharedBase, "tmp", "scratch.txt"), "scratch", "utf8");
    // Agents resolve to <base>/<agentId>, so nothing owns the base itself.
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          ownership: "explicit",
          defaults: { workspace: sharedBase },
          entries: { main: {}, helper: { workspace: path.join(home, "helper-workspace") } },
        },
      }),
      "utf8",
    );
    vi.stubEnv("OPENCLAW_HOME", home);

    const plan = await resolveBackupPlanFromDisk({ includeWorkspace: false });

    expect(plan.inventory.isTraversable(path.join(sharedBase, "tmp"))).toBe(false);
    expect(plan.inventory.isIncluded(path.join(sharedBase, "tmp", "scratch.txt"))).toBe(false);
    await fs.rm(home, { recursive: true, force: true });
  });
});

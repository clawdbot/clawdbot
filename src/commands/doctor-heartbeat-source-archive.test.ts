import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  collectHeartbeatScratchMigrationFindings,
  maybeMigrateHeartbeatFilesToScratch,
} from "./doctor-heartbeat-scratch-migration.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

async function fixture() {
  const root = tempDirs.make("openclaw-heartbeat-archive-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const sourcePath = path.join(workspace, "HEARTBEAT.md");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { workspace, heartbeat: { every: "30m" } },
      list: [{ id: "main", workspace }],
    },
  };
  const migrate = () => maybeMigrateHeartbeatFilesToScratch({ cfg, shouldRepair: true });
  const findings = () => collectHeartbeatScratchMigrationFindings(cfg);
  const archivedContents = async (
    directory = path.join(root, "backups", "heartbeat-migration"),
  ) => {
    const entries = await fs.readdir(directory, {
      recursive: true,
      withFileTypes: true,
    });
    return Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => fs.readFile(path.join(entry.parentPath, entry.name), "utf8")),
    );
  };
  return { root, cfg, sourcePath, migrate, findings, archivedContents };
}

it("treats a missing workspace as having no heartbeat source", async () => {
  const f = await fixture();
  await fs.rmdir(path.dirname(f.sourcePath));
  await expect(f.findings()).resolves.toEqual([]);
});

// Windows and root do not enforce these POSIX directory-listing permissions.
it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "surfaces an unreadable claim inventory while preserving the interrupted source",
  async () => {
    const f = await fixture();
    const workspace = path.dirname(f.sourcePath);
    const claimPath = `${f.sourcePath}.doctor-importing-${process.pid}-0123456789ab`;
    await fs.writeFile(claimPath, "Interrupted instructions");
    expect((await f.findings())[0]?.message).toContain("interrupted migration claim");
    await fs.chmod(workspace, 0o111);
    try {
      await expect(fs.lstat(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(workspace)).rejects.toMatchObject({ code: "EACCES" });
      expect(await f.findings()).toEqual([
        expect.objectContaining({
          severity: "error",
          requirement: "heartbeat-file-migration-blocked",
          message: expect.stringContaining("EACCES"),
        }),
      ]);
    } finally {
      await fs.chmod(workspace, 0o700);
    }
    expect(await fs.readFile(claimPath, "utf8")).toBe("Interrupted instructions");
  },
);

it.each([false, true])(
  "preserves every original inode across repeated imports (cross-device: %s)",
  async (crossDevice) => {
    const f = await fixture();
    const stateArchives = path.join(f.root, "backups", "heartbeat-migration");
    const rename = fs.rename.bind(fs);
    if (crossDevice) {
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (typeof to === "string" && to.startsWith(`${stateArchives}${path.sep}`)) {
          throw Object.assign(new Error("Persistent cross-device archive"), { code: "EXDEV" });
        }
        await rename(from, to);
      });
    }
    const writers: Awaited<ReturnType<typeof fs.open>>[] = [];
    try {
      for (let occurrence = 0; occurrence < 2; occurrence++) {
        await fs.writeFile(f.sourcePath, "Same checklist");
        writers.push(await fs.open(f.sourcePath, "r+"));
        expect((await f.migrate()).warnings).toEqual([]);
        await expect(fs.access(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
      for (const [index, writer] of writers.entries()) {
        expect((await writer.stat()).nlink).toBeGreaterThan(0);
        await writer.truncate(0);
        await writer.writeFile(`Late edit ${index}`);
        await writer.sync();
      }
      expect(
        await f.archivedContents(crossDevice ? path.dirname(f.sourcePath) : stateArchives),
      ).toEqual(expect.arrayContaining(["Late edit 0", "Late edit 1"]));
      if (crossDevice) {
        expect(await f.archivedContents()).toEqual(["Same checklist"]);
      }
      expect(await f.findings()).toEqual([]);
      expect(await f.migrate()).toEqual({ changes: [], warnings: [] });
    } finally {
      await Promise.all(writers.map((writer) => writer.close()));
    }
  },
);

it.each(["before claiming", "while claimed"])(
  "preserves both entries when a workspace alias is retargeted %s",
  async (phase) => {
    const f = await fixture();
    const original = path.dirname(f.sourcePath);
    const replacement = path.join(f.root, "replacement");
    const alias = path.join(f.root, "alias");
    await fs.mkdir(replacement);
    await fs.writeFile(f.sourcePath, "Same instructions");
    await fs.writeFile(path.join(replacement, "HEARTBEAT.md"), "Same instructions");
    await fs.symlink(original, alias, "dir");
    f.cfg.agents!.list![0]!.workspace = alias;
    const retarget = async () => {
      await fs.unlink(alias);
      await fs.symlink(replacement, alias, "dir");
    };
    if (phase === "before claiming") {
      const writeFile = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await writeFile(...args);
        if (typeof args[0] === "string" && args[0].includes("heartbeat-migration")) {
          await retarget();
        }
      });
    } else {
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (typeof to === "string" && to.includes(".doctor-importing-")) {
          await retarget();
        }
      });
    }
    const result = await f.migrate();
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("workspace changed");
    for (const workspace of [original, replacement]) {
      expect(await fs.readFile(path.join(workspace, "HEARTBEAT.md"), "utf8")).toBe(
        "Same instructions",
      );
    }
  },
);

it.each(["before", "after"])(
  "preserves late edits across an interruption %s the archive rename",
  async (phase) => {
    const f = await fixture();
    await fs.writeFile(f.sourcePath, "Original checklist");
    const writer = await fs.open(f.sourcePath, "r+");
    try {
      const rename = fs.rename.bind(fs);
      const fault = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (
          typeof to === "string" &&
          to.includes("heartbeat-migration") &&
          path.basename(to) === "HEARTBEAT.md"
        ) {
          if (phase === "after") {
            await rename(from, to);
          }
          throw new Error("Interrupted archive rename");
        }
        await rename(from, to);
      });
      expect((await f.migrate()).warnings.join("\n")).toContain("Interrupted archive rename");
      fault.mockRestore();
      await writer.truncate(0);
      await writer.writeFile("Late edit after interruption");
      await writer.sync();
      expect((await writer.stat()).nlink).toBeGreaterThan(0);
      await f.migrate();
      if (phase === "after") {
        expect(await f.archivedContents()).toContain("Late edit after interruption");
      } else {
        expect(await fs.readFile(f.sourcePath, "utf8")).toBe("Late edit after interruption");
      }
    } finally {
      await writer.close();
    }
  },
);

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { loadWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { materializeSkillResources, prepareSkillResourceDelivery } from "./resources.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const markdown = "---\ndescription: Workspace procedure\n---\n# Guide\nRun scripts/check.sh.\n";
async function writeSkill(workspace: string, name: string, content = markdown) {
  const directory = path.join(workspace, "skills", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), content);
  return directory;
}
function loadSnapshot(workspace: string) {
  const entries = loadWorkspaceSkills(workspace, { workspaceOnly: true });
  return buildSkillSnapshot(workspace, { entries });
}

describe("prepared workspace skill resources", () => {
  it.each(["AbortError", "TimeoutError"])(
    "preserves the exact frozen %s after partial materialization and failed cleanup",
    async (name) => {
      const workspace = temps.make("skill-rollback-");
      const directory = await writeSkill(workspace, "partial");
      await fs.writeFile(path.join(directory, "reference.md"), "supporting resource");
      const delivery = await prepareSkillResourceDelivery(loadSnapshot(workspace), () => {});
      let artifactRoot: string | undefined;
      let retainedFile: string | undefined;
      const originalWriteFile = fs.writeFile;
      const writeFile = vi
        .spyOn(fs, "writeFile")
        .mockImplementation(async (target, data, options) => {
          await originalWriteFile(target, data, options);
          if (typeof target === "string" && path.basename(target) === "SKILL.md") {
            retainedFile = target;
            artifactRoot = path.dirname(path.dirname(target));
          }
        });
      const primary = new Error("Prepared turn closed");
      primary.name = name;
      Object.freeze(primary);
      const secret = "synthetic-cleanup-secret";
      const deletionError = new Error(`EACCES: token=${secret} ${"🦞".repeat(2_000)}`);
      const originalRm = fs.rm;
      const rm = vi.spyOn(fs, "rm").mockImplementation((target, options) => {
        if (target === artifactRoot) {
          return Promise.reject(deletionError);
        }
        return originalRm(target, options);
      });
      const warn = vi.fn();
      const previousConsole = loggingState.rawConsole;
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
      try {
        const result = await materializeSkillResources(delivery!, () => {
          if (retainedFile) {
            throw primary;
          }
        }).catch((error: unknown) => error);
        expect.soft(result).toBe(primary);
        expect(retainedFile).toBeDefined();
        expect(await fs.readFile(retainedFile!, "utf8")).toBe(markdown);
        expect(existsSync(path.join(path.dirname(retainedFile!), "reference.md"))).toBe(false);
        const warning = warn.mock.calls.flat().map(String).join("\n");
        expect.soft(warning).toContain("Materialized skill cleanup failed");
        expect.soft(warning).toContain(path.basename(path.dirname(path.dirname(retainedFile!))));
        expect.soft(warning).toContain("EACCES");
        expect.soft(warning).not.toContain(secret);
        expect.soft(warning).not.toContain(markdown);
        expect.soft(warning.length).toBeLessThanOrEqual(1_200);
        expect.soft(Buffer.from(warning, "utf8").toString("utf8")).toBe(warning);
      } finally {
        writeFile.mockRestore();
        rm.mockRestore();
        loggingState.rawConsole = previousConsole;
        setLoggerOverride(null);
        resetLogger();
        if (artifactRoot) {
          await fs.rm(artifactRoot, { recursive: true, force: true });
        }
      }
    },
  );

  it.each(["same", "rehydrated"] as const)(
    "delivers current supporting bytes to a fresh worker with the %s catalog snapshot",
    async (reuse) => {
      const workspace = await fs.realpath(temps.make("skill-resource-refresh-"));
      const directory = await writeSkill(workspace, "mutable");
      const scriptPath = path.join(directory, "scripts/check.sh");
      await fs.mkdir(path.dirname(scriptPath));
      await fs.writeFile(scriptPath, "#!/bin/sh\nprintf before\n");
      const snapshot = {
        ...loadSnapshot(workspace),
        ...(reuse === "rehydrated" ? { version: 1 } : {}),
      };
      const first = await prepareSkillResourceDelivery(snapshot, () => {});
      const preparedBytes = structuredClone(first);
      await fs.writeFile(scriptPath, "#!/bin/sh\nprintf after\n");
      const next = await prepareSkillResourceDelivery(
        reuse === "rehydrated" ? structuredClone(snapshot) : snapshot,
        () => {},
      );
      const worker = await materializeSkillResources(next!, () => {});
      try {
        const skill = worker.snapshot.resolvedSkills![0]!;
        expect(await fs.readFile(path.join(skill.baseDir, "scripts/check.sh"), "utf8")).toBe(
          "#!/bin/sh\nprintf after\n",
        );
        expect(await fs.readFile(skill.filePath, "utf8")).toBe(markdown);
        expect(first).toEqual(preparedBytes);
      } finally {
        await worker.cleanup();
      }
    },
  );

  it.each([false, true])(
    "keeps concurrent turn cancellation isolated (rehydrated: %s)",
    async (rehydrated) => {
      const workspace = await fs.realpath(temps.make("skill-turns-"));
      await writeSkill(workspace, "independent");
      const snapshot = { ...loadSnapshot(workspace), ...(rehydrated ? { version: 1 } : {}) };
      let closed = false;
      const cancelled = prepareSkillResourceDelivery(snapshot, () => {
        if (closed) {
          throw new Error("Turn closed");
        }
      });
      const active = prepareSkillResourceDelivery(
        rehydrated ? structuredClone(snapshot) : snapshot,
        () => {},
      );
      closed = true;
      const [cancelledResult, activeResult] = await Promise.allSettled([cancelled, active]);
      expect(cancelledResult).toMatchObject({
        status: "rejected",
        reason: new Error("Turn closed"),
      });
      expect(activeResult).toMatchObject({
        status: "fulfilled",
        value: { skills: [{ name: "independent" }] },
      });
      expect(await prepareSkillResourceDelivery(snapshot, () => {})).toEqual(await active);
    },
  );

  it.runIf(process.platform !== "win32")(
    "omits a discovered skill whose root becomes a broken symlink between turns",
    async () => {
      const workspace = await fs.realpath(temps.make("skill-stale-root-"));
      const healthyDir = await writeSkill(workspace, "healthy");
      const staleDir = await writeSkill(workspace, "stale");
      const snapshot = loadSnapshot(workspace);
      expect((await prepareSkillResourceDelivery(snapshot, () => {}))?.skills).toHaveLength(2);

      await fs.rm(staleDir, { recursive: true });
      await fs.symlink(path.join(workspace, "missing-stale-target"), staleDir, "dir");

      await expect(prepareSkillResourceDelivery(snapshot, () => {})).resolves.toMatchObject({
        skills: [{ name: "healthy" }],
      });
      await fs.rm(healthyDir, { recursive: true });
      await fs.symlink(path.join(workspace, "missing-healthy-target"), healthyDir, "dir");
      await expect(prepareSkillResourceDelivery(snapshot, () => {})).resolves.toEqual({
        version: 1,
        skills: [],
      });
      await expect(
        prepareSkillResourceDelivery(snapshot, () => {}, [
          { name: "stale", path: path.join(staleDir, "SKILL.md") },
        ]),
      ).rejects.toMatchObject({
        code: "INVALID_BUNDLE",
        message: expect.stringMatching(/skill="stale".*root=.*stale.*ENOENT/s),
      });
    },
  );

  it("names an unavailable explicit skill and root", async () => {
    const workspace = await fs.realpath(temps.make("skill-missing-explicit-"));
    await writeSkill(workspace, "visible");
    const missingPath = path.join(workspace, "skills", "missing", "SKILL.md");

    await expect(
      prepareSkillResourceDelivery(loadSnapshot(workspace), () => {}, [
        { name: "missing", path: missingPath },
      ]),
    ).rejects.toMatchObject({
      code: "INVALID_BUNDLE",
      message: expect.stringMatching(/skill="missing".*root=.*missing.*ENOENT/s),
    });
  });

  it.runIf(process.platform !== "win32")(
    "keeps nested links fail-closed with selected skill diagnostics",
    async () => {
      const workspace = await fs.realpath(temps.make("skill-nested-link-"));
      const directory = await writeSkill(workspace, "linked");
      await fs.symlink("SKILL.md", path.join(directory, "linked-skill"));

      await expect(
        prepareSkillResourceDelivery(loadSnapshot(workspace), () => {}),
      ).rejects.toMatchObject({
        code: "INVALID_BUNDLE",
        message: expect.stringMatching(/skill="linked".*root=.*linked.*path=.*linked-skill/s),
      });
    },
  );

  it("preserves a loaded directory-name fallback and exact instruction and executable bytes", async () => {
    const workspace = await fs.realpath(temps.make("skill-resources-"));
    const directory = await writeSkill(workspace, "directory-name");
    const script = "#!/bin/sh\nprintf ready\n";
    await fs.mkdir(path.join(directory, "scripts"));
    await fs.writeFile(path.join(directory, "scripts/check.sh"), script, { mode: 0o700 });
    const snapshot = loadSnapshot(workspace);
    expect(snapshot.resolvedSkills).toMatchObject([
      { name: "directory-name", description: "Workspace procedure" },
    ]);
    const delivery = await prepareSkillResourceDelivery(snapshot, () => {});
    expect(delivery?.skills).toMatchObject([{ name: "directory-name" }]);
    const materialized = await materializeSkillResources(delivery!, () => {});
    try {
      const skill = materialized.snapshot.resolvedSkills![0]!;
      expect(skill.name).toBe("directory-name");
      expect(skill.description).toBe("Workspace procedure");
      expect(await fs.readFile(skill.filePath, "utf8")).toBe(markdown);
      expect(await fs.readFile(path.join(skill.baseDir, "scripts/check.sh"), "utf8")).toBe(script);
      if (process.platform !== "win32") {
        expect((await fs.stat(materialized.directory)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(skill.filePath)).mode & 0o777).toBe(0o400);
        expect((await fs.stat(path.join(skill.baseDir, "scripts/check.sh"))).mode & 0o777).toBe(
          0o500,
        );
      }
    } finally {
      await materialized.cleanup();
    }
  });

  it("excludes Git and dependency trees before spending the traversal budget", async () => {
    const workspace = await fs.realpath(temps.make("skill-exclusions-"));
    const directory = await writeSkill(
      workspace,
      "guide",
      `---\nname: guide\ndescription: Test\n---\n# Guide\n`,
    );
    await fs.mkdir(path.join(directory, ".git"));
    await Promise.all(
      Array.from({ length: 513 }, (_, index) =>
        fs.writeFile(path.join(directory, ".git", String(index)), ""),
      ),
    );
    await fs.mkdir(path.join(directory, "node_modules", "dependency"), { recursive: true });
    await fs.writeFile(path.join(directory, "node_modules", "dependency", "index.js"), "excluded");
    const delivery = await prepareSkillResourceDelivery(loadSnapshot(workspace), () => {});
    expect(delivery?.skills[0]?.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  });

  it("delivers a default prepared catalog larger than the personal selection cap", async () => {
    const workspace = await fs.realpath(temps.make("skill-catalog-"));
    for (let index = 0; index < 65; index++) {
      const name = `skill-${index}`;
      await writeSkill(workspace, name, `---\nname: ${name}\ndescription: Test\n---\n# Guide\n`);
    }
    const snapshot = loadSnapshot(workspace);
    expect(snapshot.prompt.match(/<name>/g)).toHaveLength(65);
    const delivery = await prepareSkillResourceDelivery(snapshot, () => {});
    expect(delivery?.skills).toHaveLength(65);
    const materialized = await materializeSkillResources(delivery!, () => {});
    try {
      expect(materialized.snapshot.skills.map((skill) => skill.name)).toEqual(
        snapshot.resolvedSkills!.map((skill) => skill.name),
      );
    } finally {
      await materialized.cleanup();
    }
  });

  it("does not read prompt-omitted bundles and includes an explicit hidden skill without changing the snapshot", async () => {
    const workspace = await fs.realpath(temps.make("skill-selected-"));
    await writeSkill(
      workspace,
      "visible",
      "---\nname: visible\ndescription: Test\n---\n# Visible\n",
    );
    const hiddenDir = await writeSkill(
      workspace,
      "hidden",
      "---\nname: hidden\ndescription: Hidden procedure\ndisable-model-invocation: true\n---\n# Hidden\n",
    );
    const omittedDir = await writeSkill(
      workspace,
      "z-omitted",
      "---\nname: z-omitted\ndescription: Test\n---\n# Omitted\n",
    );
    const entries = loadWorkspaceSkills(workspace, { workspaceOnly: true });
    const snapshot = buildSkillSnapshot(workspace, {
      entries,
      config: { skills: { limits: { maxSkillsInPrompt: 1 } } },
    });
    expect(snapshot.prompt).toContain("<name>visible</name>");
    expect(snapshot.prompt).not.toContain("<name>z-omitted</name>");
    await fs.rm(omittedDir, { recursive: true });
    const before = structuredClone(snapshot);
    const ordinary = await prepareSkillResourceDelivery(snapshot, () => {});
    expect(ordinary?.skills.map((skill) => skill.name)).toEqual(["visible"]);
    const explicit = await prepareSkillResourceDelivery(snapshot, () => {}, [
      { name: "hidden", path: path.join(hiddenDir, "SKILL.md") },
    ]);
    expect(explicit?.skills.map((skill) => skill.name)).toEqual(["visible", "hidden"]);
    expect(explicit?.skills[1]?.modelVisible).toBe(true);
    expect(snapshot).toEqual(before);
    expect(await prepareSkillResourceDelivery(snapshot, () => {})).toEqual(ordinary);
  });
});

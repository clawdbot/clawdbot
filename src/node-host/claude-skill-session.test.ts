import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { loadWorkspaceSkills } from "../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { prepareSkillResourceDelivery } from "../skills/runtime/resources.js";
import { prepareNodeClaudeSkillSession } from "./claude-skill-session.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

describe("node Claude skill artifact cleanup", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([false, true])(
    "grants only the artifact root and cleans independent inputs after close (Workshop: %s)",
    async (workshop) => {
      const workspace = temps.make("node-skill-session-");
      const skillDir = path.join(workspace, "skills", "guide");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\ndescription: Guide\n---\n# Guide\n",
      );
      const resources = await prepareSkillResourceDelivery(
        buildSkillSnapshot(workspace, {
          entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
        }),
        () => {},
      );
      const session = await prepareNodeClaudeSkillSession({
        signal: new AbortController().signal,
        emitChunk: vi.fn(),
        onInput: vi.fn(),
        frames: {
          send: vi.fn(),
          onMessage: (listener) => {
            void listener(
              Buffer.from(
                JSON.stringify({
                  type: "init",
                  resources,
                  ...(workshop ? { workshop: { description: "Fixture", inputSchema: {} } } : {}),
                }),
              ),
            );
            return vi.fn();
          },
        },
      });
      const artifactRoot = session.argv[session.argv.indexOf("--add-dir") + 1]!;
      const skillPath = session.rewriteReferences(path.join(skillDir, "SKILL.md"));
      const configPath = workshop
        ? session.argv[session.argv.indexOf("--mcp-config") + 1]!
        : undefined;
      const warn = vi.fn();
      const previousConsole = loggingState.rawConsole;
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
      try {
        expect(session.argv.filter((arg) => arg === "--add-dir")).toHaveLength(1);
        expect(path.dirname(path.dirname(skillPath))).toBe(artifactRoot);
        expect((await fs.stat(artifactRoot)).mode & 0o777).toBe(0o700);
        expect(session.catalog).toContain(skillPath);
        if (configPath) {
          expect(path.relative(artifactRoot, configPath).startsWith(`..${path.sep}`)).toBe(true);
          expect((await fs.stat(path.dirname(configPath))).mode & 0o777).toBe(0o700);
        }
        await fs.chmod(path.dirname(skillPath), 0o500);
        await session.close();
        await expect(session.writeStdout("late output")).rejects.toThrow("invocation closed");
        await expect(session.cleanup()).resolves.toBeUndefined();
        expect(await fs.readFile(skillPath, "utf8")).toContain("# Guide");
        if (configPath) {
          await expect(fs.stat(path.dirname(configPath))).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls.flat().join("\n")).toContain(artifactRoot);
      } finally {
        await session.close();
        await fs.chmod(path.dirname(skillPath), 0o700);
        await session.cleanup();
        loggingState.rawConsole = previousConsole;
        setLoggerOverride(null);
        resetLogger();
      }
    },
  );

  it("preserves the exact frozen setup error when partial skill cleanup fails", async () => {
    const workspace = temps.make("node-skill-rollback-");
    const skillDir = path.join(workspace, "skills", "partial");
    await fs.mkdir(skillDir, { recursive: true });
    const markdown = "---\ndescription: Partial materialization proof\n---\n# Instructions\n";
    await fs.writeFile(path.join(skillDir, "SKILL.md"), markdown);
    await fs.writeFile(path.join(skillDir, "reference.md"), "supporting resource");
    const resources = await prepareSkillResourceDelivery(
      buildSkillSnapshot(workspace, {
        entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
      }),
      () => {},
    );
    const primary = new Error("Node skill setup cancelled");
    primary.name = "AbortError";
    Object.freeze(primary);
    const controller = new AbortController();
    let directory: string | undefined;
    let retainedFile: string | undefined;
    const originalWriteFile = fs.writeFile;
    const writeFile = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (target, data, options) => {
        await originalWriteFile(target, data, options);
        if (typeof target === "string" && path.basename(target) === "SKILL.md") {
          retainedFile = target;
          directory = path.dirname(path.dirname(target));
          controller.abort(primary);
        }
      });
    const originalRm = fs.rm;
    const deletionError = new Error("EACCES: retained node skill artifact");
    const rm = vi.spyOn(fs, "rm").mockImplementation((target, options) => {
      if (
        directory &&
        (String(target) === directory || String(target).startsWith(`${directory}${path.sep}`))
      ) {
        return Promise.reject(deletionError);
      }
      return originalRm(target, options);
    });
    const warn = vi.fn();
    const previousConsole = loggingState.rawConsole;
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const unsubscribe = vi.fn();
    try {
      const result = await prepareNodeClaudeSkillSession({
        signal: controller.signal,
        emitChunk: vi.fn(),
        onInput: vi.fn(),
        frames: {
          send: vi.fn(),
          onMessage: (listener) => {
            void listener(Buffer.from(JSON.stringify({ type: "init", resources })));
            return unsubscribe;
          },
        },
      }).catch((error: unknown) => error);
      expect.soft(result).toBe(primary);
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(retainedFile).toBeDefined();
      expect(await fs.readFile(retainedFile!, "utf8")).toBe(markdown);
      await expect(
        fs.stat(path.join(path.dirname(retainedFile!), "reference.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const warning = warn.mock.calls.flat().map(String).join("\n");
      expect(warning).toContain("Materialized skill cleanup failed");
      expect(warn).toHaveBeenCalledOnce();
      expect(warning).toContain(directory);
      expect(warning).toContain("EACCES");
      expect(warning).not.toContain(markdown);
    } finally {
      writeFile.mockRestore();
      rm.mockRestore();
      loggingState.rawConsole = previousConsole;
      setLoggerOverride(null);
      resetLogger();
      if (directory) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  });
});

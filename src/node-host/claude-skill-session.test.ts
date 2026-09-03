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
  it("preserves the exact frozen setup error when enclosing skill cleanup fails", async () => {
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
          directory = path.resolve(path.dirname(target), "../../..");
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
      expect.soft(warning).toContain("Node Claude skill session cleanup failed");
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

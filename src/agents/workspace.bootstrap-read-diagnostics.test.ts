import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { buildBootstrapContextFiles } from "./embedded-agent-helpers/bootstrap.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "./workspace-bootstrap-read.js";
import { DEFAULT_AGENTS_FILENAME, loadWorkspaceBootstrapFiles } from "./workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

function captureWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  const warn = vi.fn();
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return warn;
}

describe("workspace bootstrap read diagnostics", () => {
  it("marks oversized bootstrap files unreadable and warns with the bounded-read reason", async () => {
    const tempDir = tempDirs.make("openclaw-workspace-");
    const agentsPath = path.join(tempDir, DEFAULT_AGENTS_FILENAME);
    await fs.writeFile(agentsPath, "x".repeat(MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES + 1));
    const warn = captureWarningLogger();

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const agents = files.find((file) => file.name === DEFAULT_AGENTS_FILENAME);
    const warningText = warn.mock.calls.flat().map(String).join("\n");

    expect(agents?.missing).toBe(false);
    expect(agents?.content).toBe(
      `[UNREADABLE: File exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes]`,
    );
    if (!agents) {
      throw new Error("expected AGENTS.md bootstrap record");
    }
    expect(buildBootstrapContextFiles([agents])).toEqual([
      { path: agentsPath, content: agents.content },
    ]);
    expect(warningText).toContain(agentsPath);
    expect(warningText).toContain(`File exceeds ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES} bytes`);
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import "../test-helpers/fast-coding-tools.js";
import "../test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "../agent-tools.js";
import { prepareRootedExecutionCapability } from "../rooted-run-params.js";
import type { resolveSandboxContext as ResolveSandboxContext } from "../sandbox/context.js";
import {
  expectReadWriteEditTools,
  getTextContent,
} from "../test-helpers/agent-tools-fs-helpers.js";
import { createAgentToolsSandboxContext } from "../test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";

const resolveSandboxContext = vi.hoisted(() => vi.fn<typeof ResolveSandboxContext>());
vi.mock("../sandbox.js", () => ({ resolveSandboxContext }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const config = { tools: { fs: { workspaceOnly: false } } };

async function prepare(root: string) {
  return prepareRootedExecutionCapability({
    rootedExecution: { root },
    agentId: "main",
    sessionId: "workshop-review",
    sessionKey: "agent:main:skill-collection-review",
    config,
  });
}

function codingTools(capability: Awaited<ReturnType<typeof prepare>>) {
  return expectReadWriteEditTools(
    createOpenClawCodingTools({
      ...capability,
      config,
      toolConstructionPlan: {
        includeBaseCodingTools: true,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    }),
  );
}

describe("prepared rooted execution", () => {
  beforeEach(() => {
    resolveSandboxContext.mockReset().mockResolvedValue(null);
  });

  it.each(["ro", "none"] as const)(
    "rejects a configured %s sandbox before granting file access",
    async (workspaceAccess) => {
      const root = tempDirs.make("openclaw-rooted-review-");
      resolveSandboxContext.mockResolvedValue(
        createAgentToolsSandboxContext({ workspaceDir: root, workspaceAccess }),
      );

      await expect(prepare(root)).rejects.toThrow(
        "sandbox workspace is not read-write; collection review skipped",
      );
    },
  );

  it("confines file access to the requested root even when configured filesystem access is broad", async () => {
    const parent = tempDirs.make("openclaw-rooted-review-");
    const root = path.join(parent, "workshop");
    const outside = path.join(parent, "outside.md");
    await fs.writeFile(outside, "outside unchanged");
    const { readTool, writeTool } = codingTools(await prepare(root));
    await fs.symlink(outside, path.join(root, "outside-link.md"));

    await writeTool.execute("report", { path: "report.md", content: "review complete" });
    expect(getTextContent(await readTool.execute("read-report", { path: "report.md" }))).toContain(
      "review complete",
    );
    for (const filePath of [outside, "../outside.md", "outside-link.md"]) {
      await expect(readTool.execute("read-outside", { path: filePath })).rejects.toThrow(
        /escapes|outside|symlink/i,
      );
      await expect(
        writeTool.execute("write-outside", { path: filePath, content: "must not write" }),
      ).rejects.toThrow(/escapes|outside|symlink/i);
    }
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("outside unchanged");
  });

  it("reads, edits, and writes a writable Workshop through the configured sandbox bridge", async () => {
    const root = tempDirs.make("openclaw-rooted-sandbox-review-");
    await fs.writeFile(path.join(root, "SKILL.md"), "Original guidance\n");
    const bridge = createHostSandboxFsBridge(root);
    const readFile = vi.spyOn(bridge, "readFile");
    const writeFile = vi.spyOn(bridge, "writeFile");
    resolveSandboxContext.mockResolvedValue(
      createAgentToolsSandboxContext({ workspaceDir: root, fsBridge: bridge }),
    );
    const { readTool, writeTool, editTool } = codingTools(await prepare(root));

    expect(getTextContent(await readTool.execute("read-skill", { path: "SKILL.md" }))).toContain(
      "Original guidance",
    );
    expect(readFile).toHaveBeenCalled();
    await editTool.execute("edit-skill", {
      path: "SKILL.md",
      edits: [{ oldText: "Original guidance", newText: "Reviewed guidance" }],
    });
    expect(writeFile).toHaveBeenCalled();
    writeFile.mockClear();
    await writeTool.execute("write-report", {
      path: "report.md",
      content: "Reviewed SKILL.md",
    });

    expect(writeFile).toHaveBeenCalled();
    await expect(fs.readFile(path.join(root, "SKILL.md"), "utf8")).resolves.toBe(
      "Reviewed guidance\n",
    );
    await expect(fs.readFile(path.join(root, "report.md"), "utf8")).resolves.toBe(
      "Reviewed SKILL.md",
    );
  });
});

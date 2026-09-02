import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createOpenClawCodingTools } from "../../../../src/agents/agent-tools.js";
import type { AnyAgentTool } from "../../../../src/agents/agent-tools.types.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const ARTIFACT = "mutation-receipt.md";
const DRAFT = "# Workspace mutation\n\nstate: DRAFT\n";
const FINAL = "# Workspace mutation\n\nstate: FINAL\n";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireTool(tools: AnyAgentTool[], name: string): AnyAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`expected assembled ${name} tool`);
  }
  return tool;
}

function textOf(result: Awaited<ReturnType<AnyAgentTool["execute"]>>): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

test("OpenClaw applies and edits exact workspace bytes while rejecting escapes", async () => {
  const root = tempDirs.make("openclaw-workspace-mutation-");
  const workspace = path.join(root, "workspace");
  const sentinel = path.join(root, "outside-sentinel");
  await fs.mkdir(workspace);
  await fs.writeFile(sentinel, "OUTSIDE\n", "utf8");

  const config: OpenClawConfig = {
    tools: {
      fs: { workspaceOnly: true },
      exec: { applyPatch: { enabled: true, workspaceOnly: true } },
    },
  };
  const tools = createOpenClawCodingTools({
    workspaceDir: workspace,
    modelProvider: "openai",
    modelId: "gpt-5.4",
    config,
    toolConstructionPlan: {
      includeBaseCodingTools: true,
      includeShellTools: true,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: false,
    },
  });
  const applyPatch = requireTool(tools, "apply_patch");
  const edit = requireTool(tools, "edit");

  const applied = await applyPatch.execute("apply-draft", {
    input: [
      "*** Begin Patch",
      `*** Add File: ${ARTIFACT}`,
      "+# Workspace mutation",
      "+",
      "+state: DRAFT",
      "*** End Patch",
    ].join("\n"),
  });
  expect(textOf(applied)).toBe(`Success. Updated the following files:\nA ${ARTIFACT}`);
  expect(applied.details).toEqual({
    summary: { added: [ARTIFACT], modified: [], deleted: [] },
  });
  await expect(fs.readFile(path.join(workspace, ARTIFACT), "utf8")).resolves.toBe(DRAFT);

  await expect(
    applyPatch.execute("reject-escape", {
      input: [
        "*** Begin Patch",
        "*** Update File: ../outside-sentinel",
        "@@",
        "-OUTSIDE",
        "+ESCAPED",
        "*** End Patch",
      ].join("\n"),
    }),
  ).rejects.toThrow(/Path escapes sandbox root/);
  await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("OUTSIDE\n");

  const edited = await edit.execute("edit-final", {
    path: ARTIFACT,
    edits: [{ oldText: "state: DRAFT", newText: "state: FINAL" }],
  });
  const artifactPath = path.join(workspace, ARTIFACT);
  expect(textOf(edited)).toBe(`Successfully replaced 1 block(s) in ${artifactPath}.`);
  expect(edited.details).toMatchObject({
    changed: true,
    firstChangedLine: 3,
  });
  const details = edited.details as {
    changed: true;
    diff: string;
    patch: string;
    firstChangedLine?: number;
  };
  expect(details.diff).toBe(
    [" 1 # Workspace mutation", " 2 ", "-3 state: DRAFT", "+3 state: FINAL"].join("\n"),
  );
  expect(details.patch).toContain(`--- ${artifactPath}`);
  expect(details.patch).toContain(`+++ ${artifactPath}`);
  expect(details.patch).toContain("-state: DRAFT\n+state: FINAL");
  const finalBytes = await fs.readFile(path.join(workspace, ARTIFACT), "utf8");
  expect(finalBytes).toBe(FINAL);
  expect(finalBytes).not.toContain("DRAFT");
});

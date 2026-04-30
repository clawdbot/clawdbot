import fs from "node:fs";
import path from "node:path";
import { assert, readJson, requireArg, write, writeJson } from "./common.mjs";

function writeOpenWebUiWorkspace() {
  const workspace =
    process.env.OPENCLAW_WORKSPACE_DIR || path.join(process.env.HOME, ".openclaw", "workspace");
  write(
    path.join(workspace, "IDENTITY.md"),
    "# Identity\n\n- Name: OpenClaw\n- Purpose: Open WebUI Docker compatibility smoke test assistant.\n",
  );
  writeJson(path.join(workspace, ".openclaw", "workspace-state.json"), {
    version: 1,
    setupCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  fs.rmSync(path.join(workspace, "BOOTSTRAP.md"), { force: true });
}

function writeAgentsDeleteConfig() {
  const stateDir = requireArg(process.env.OPENCLAW_STATE_DIR, "OPENCLAW_STATE_DIR");
  const sharedWorkspace = requireArg(process.env.SHARED_WORKSPACE, "SHARED_WORKSPACE");
  fs.mkdirSync(sharedWorkspace, { recursive: true });
  writeJson(path.join(stateDir, "openclaw.json"), {
    agents: {
      list: [
        { id: "main", workspace: sharedWorkspace },
        { id: "ops", workspace: sharedWorkspace },
      ],
    },
  });
}

function assertAgentsDeleteResult([outputPath]) {
  let parsed;
  try {
    parsed = readJson(requireArg(outputPath, "outputPath"));
  } catch (error) {
    console.error("agents delete --json did not emit valid JSON:");
    console.error(fs.readFileSync(outputPath, "utf8").trim());
    throw error;
  }
  for (const [actual, expected, label] of [
    [parsed.agentId, "ops", "agentId"],
    [parsed.workspace, process.env.SHARED_WORKSPACE, "workspace"],
    [parsed.workspaceRetained, true, "workspaceRetained"],
    [parsed.workspaceRetainedReason, "shared", "workspaceRetainedReason"],
  ]) {
    assert(actual === expected, `${label} mismatch: ${JSON.stringify(actual)}`);
  }
  assert(
    Array.isArray(parsed.workspaceSharedWith) && parsed.workspaceSharedWith.includes("main"),
    "missing shared-with main marker",
  );
  assert(fs.existsSync(process.env.SHARED_WORKSPACE), "shared workspace was removed");
  const remaining =
    readJson(path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json"))?.agents?.list ?? [];
  assert(Array.isArray(remaining), "agents list missing after delete");
  assert(!remaining.some((entry) => entry?.id === "ops"), "deleted agent remained in config");
  assert(
    remaining.some((entry) => entry?.id === "main"),
    "main agent missing after delete",
  );
  console.log("agents delete shared workspace smoke ok");
}

export const workspaceCommands = {
  "openwebui-workspace": writeOpenWebUiWorkspace,
  "agents-delete-config": writeAgentsDeleteConfig,
  "agents-delete-assert": assertAgentsDeleteResult,
};

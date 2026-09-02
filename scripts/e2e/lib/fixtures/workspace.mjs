// Workspace fixture writer commands for E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { readPositiveIntEnv } from "../env-limits.mjs";
import { readTextFileTail } from "../text-file-utils.mjs";
import { assert, readJson, requireArg, write } from "./common.mjs";

const AGENTS_DELETE_OUTPUT_MAX_BYTES = readPositiveIntEnv(
  "OPENCLAW_FIXTURE_AGENTS_DELETE_OUTPUT_MAX_BYTES",
  1024 * 1024,
);
const ERROR_DETAIL_TAIL_BYTES = 16 * 1024;

function writeOpenWebUiWorkspace() {
  const workspace =
    process.env.OPENCLAW_WORKSPACE_DIR || path.join(process.env.HOME, ".openclaw", "workspace");
  write(
    path.join(workspace, "IDENTITY.md"),
    "# Identity\n\n- Name: OpenClaw\n- Purpose: Open WebUI Docker compatibility smoke test assistant.\n",
  );
  fs.rmSync(path.join(workspace, ".openclaw", "workspace-state.json"), { force: true });
  fs.rmSync(path.join(workspace, "openclaw-workspace-state.json"), { force: true });
  fs.rmSync(path.join(workspace, "BOOTSTRAP.md"), { force: true });
}

function assertAgentsDeleteResult([outputPath, agentsPath]) {
  const resolvedOutputPath = requireArg(outputPath, "outputPath");
  const resolvedAgentsPath = requireArg(agentsPath, "agentsPath");
  const outputStat = fs.statSync(resolvedOutputPath);
  if (outputStat.isFile() && outputStat.size > AGENTS_DELETE_OUTPUT_MAX_BYTES) {
    throw new Error(
      `agents delete --json output exceeded ${AGENTS_DELETE_OUTPUT_MAX_BYTES} bytes:\nstdout tail=${readTextFileTail(
        resolvedOutputPath,
        ERROR_DETAIL_TAIL_BYTES,
      )}`,
    );
  }
  let parsed;
  try {
    parsed = readJson(resolvedOutputPath);
  } catch (error) {
    console.error("agents delete --json did not emit valid JSON:");
    console.error(readTextFileTail(resolvedOutputPath, ERROR_DETAIL_TAIL_BYTES).trim());
    const message = error instanceof Error ? error.message.split("\n").at(0) : String(error);
    throw new Error(`agents delete --json parse failed: ${message}`, { cause: error });
  }
  /** @type {Array<[unknown, unknown, string]>} */
  const comparisons = [
    [parsed.agentId, "ops", "agentId"],
    [parsed.workspace, process.env.SHARED_WORKSPACE, "workspace"],
    [parsed.workspaceRetained, true, "workspaceRetained"],
    [parsed.workspaceRetainedReason, "shared", "workspaceRetainedReason"],
    [parsed.transport, "gateway", "transport"],
  ];
  for (const [actual, expected, label] of comparisons) {
    assert(actual === expected, `${label} mismatch: ${JSON.stringify(actual)}`);
  }
  assert(
    Array.isArray(parsed.workspaceSharedWith) && parsed.workspaceSharedWith.includes("alpha"),
    "missing shared-with alpha marker",
  );
  assert(fs.existsSync(process.env.SHARED_WORKSPACE), "shared workspace was removed");
  const agents = readJson(resolvedAgentsPath);
  assert(Array.isArray(agents), "agents list did not emit an array");
  assert(!agents.some((entry) => entry?.id === "ops"), "deleted agent remained in agent list");
  assert(
    agents.some(
      (entry) => entry?.id === "alpha" && entry?.workspace === process.env.SHARED_WORKSPACE,
    ),
    "shared surviving agent missing from agent list",
  );
  console.log("agents delete shared workspace smoke ok");
}

export const workspaceCommands = {
  "openwebui-workspace": writeOpenWebUiWorkspace,
  "agents-delete-assert": assertAgentsDeleteResult,
};

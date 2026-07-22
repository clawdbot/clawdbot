// Workspace fixture writer commands for E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import { readTextFileTail } from "../text-file-utils.mjs";
import { assert, readJson, requireArg, write, writeJson } from "./common.mjs";

const AGENTS_DELETE_OUTPUT_MAX_BYTES = readPositiveIntEnv(
  "OPENCLAW_FIXTURE_AGENTS_DELETE_OUTPUT_MAX_BYTES",
  1024 * 1024,
);
const ERROR_DETAIL_TAIL_BYTES = 16 * 1024;

function readPositiveIntEnv(name, fallback) {
  const text = String(process.env[name] ?? fallback).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

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
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  fs.mkdirSync(sharedWorkspace, { recursive: true });
  writeJson(path.join(stateDir, "openclaw.json"), {
    agents: {
      entries: {
        main: { workspace: sharedWorkspace },
        ops: { workspace: sharedWorkspace },
      },
    },
    ...(gatewayToken ? { gateway: { auth: { mode: "token", token: gatewayToken } } } : {}),
  });
}

function assertAgentsDeleteResult([outputPath]) {
  const resolvedOutputPath = requireArg(outputPath, "outputPath");
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
  ];
  for (const [actual, expected, label] of comparisons) {
    assert(actual === expected, `${label} mismatch: ${JSON.stringify(actual)}`);
  }
  assert(
    Array.isArray(parsed.workspaceSharedWith) && parsed.workspaceSharedWith.includes("main"),
    "missing shared-with main marker",
  );
  assert(fs.existsSync(process.env.SHARED_WORKSPACE), "shared workspace was removed");
  const remaining =
    readJson(path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json"))?.agents?.entries ?? {};
  assert(remaining && typeof remaining === "object", "agent entries missing after delete");
  assert(!Object.hasOwn(remaining, "ops"), "deleted agent remained in config");
  assert(Object.hasOwn(remaining, "main"), "main agent missing after delete");
  console.log("agents delete shared workspace smoke ok");
}

export const workspaceCommands = {
  "openwebui-workspace": writeOpenWebUiWorkspace,
  "agents-delete-config": writeAgentsDeleteConfig,
  "agents-delete-assert": assertAgentsDeleteResult,
};

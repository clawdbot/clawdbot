import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { extractQaToolPayload } from "./extract-tool-payload.js";
import { resolveQaNodeExecPath } from "./node-exec.js";
import type {
  QaRuntimeActionHandlerEnv,
  QaSkillStatusEntry,
  QaSuiteRuntimeEnv,
  QaTransportActionName,
} from "./suite-runtime-types.js";

const requireFromHere = createRequire(import.meta.url);

function findSkill(skills: QaSkillStatusEntry[], name: string) {
  return skills.find((skill) => skill.name === name);
}

async function writeWorkspaceSkill(params: {
  env: Pick<QaSuiteRuntimeEnv, "gateway">;
  name: string;
  body: string;
}) {
  const skillDir = path.join(params.env.gateway.workspaceDir, "skills", params.name);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillPath, `${params.body.trim()}\n`, "utf8");
  return skillPath;
}

async function callPluginToolsMcp(params: {
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "repoRoot">;
  toolName: string;
  args: Record<string, unknown>;
}) {
  const transportEnv = Object.fromEntries(
    Object.entries(params.env.gateway.runtimeEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const nodeExecPath = await resolveQaNodeExecPath();
  const transport = new StdioClientTransport({
    command: nodeExecPath,
    args: [
      "--import",
      requireFromHere.resolve("tsx"),
      path.join(params.env.repoRoot, "src/mcp/plugin-tools-serve.ts"),
    ],
    stderr: "pipe",
    cwd: params.env.gateway.tempRoot,
    env: transportEnv,
  });
  const client = new Client({ name: "openclaw-qa-suite", version: "0.0.0" }, {});
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === params.toolName);
    if (!tool) {
      const availableTools = listed.tools
        .map((entry) => entry.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
        .toSorted();
      throw new Error(
        `MCP tool missing: ${params.toolName}; available tools: ${availableTools.join(", ") || "<none>"}`,
      );
    }
    return await client.callTool({
      name: params.toolName,
      arguments: params.args,
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function handleQaAction(params: {
  env: QaRuntimeActionHandlerEnv;
  action: QaTransportActionName;
  args: Record<string, unknown>;
}) {
  const result = await params.env.transport.handleAction({
    action: params.action,
    args: params.args,
    cfg: params.env.cfg,
  });
  return extractQaToolPayload(result as Parameters<typeof extractQaToolPayload>[0]);
}

export { callPluginToolsMcp, findSkill, handleQaAction, writeWorkspaceSkill };

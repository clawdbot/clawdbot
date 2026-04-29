import fs from "node:fs/promises";
import path from "node:path";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCiSafeCodexConfig(params: {
  projectPath: string;
  approvalPolicy?: string;
  modelReasoningEffort?: string;
  sandboxMode?: string;
}): string {
  if (!params.projectPath || typeof params.projectPath !== "string") {
    throw new Error("projectPath is required.");
  }
  const resolvedProjectPath = path.resolve(params.projectPath);
  const approvalPolicy = params.approvalPolicy ?? "never";
  const modelReasoningEffort = params.modelReasoningEffort ?? "low";
  const sandboxMode = params.sandboxMode ?? "workspace-write";
  return [
    "# Generated for Codex CI runs.",
    "# Keep the checked-out repo trusted while avoiding maintainer-local",
    "# provider/profile overrides that do not exist on CI runners.",
    `approval_policy = ${tomlString(approvalPolicy)}`,
    `sandbox_mode = ${tomlString(sandboxMode)}`,
    `model_reasoning_effort = ${tomlString(modelReasoningEffort)}`,
    "",
    `[projects.${tomlString(resolvedProjectPath)}]`,
    'trust_level = "trusted"',
    "",
  ].join("\n");
}

export async function writeCiSafeCodexConfig(params: {
  outputPath: string;
  projectPath: string;
  approvalPolicy?: string;
  modelReasoningEffort?: string;
  sandboxMode?: string;
}): Promise<string> {
  if (!params.outputPath || typeof params.outputPath !== "string") {
    throw new Error("outputPath is required.");
  }
  const rendered = buildCiSafeCodexConfig(params);
  await fs.mkdir(path.dirname(params.outputPath), { recursive: true });
  await fs.writeFile(params.outputPath, rendered, "utf-8");
  return rendered;
}

if (path.basename(process.argv[1] ?? "") === "prepare-codex-ci-config.ts") {
  const outputPath = process.argv[2];
  const projectPath = process.argv[3] ?? process.cwd();
  await writeCiSafeCodexConfig({ outputPath, projectPath });
}

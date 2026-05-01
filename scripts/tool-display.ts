import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/agents/tool-display-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outputPath = path.join(
  repoRoot,
  "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json",
);
const toolSources = [
  path.join(repoRoot, "src/agents/apply-patch.ts"),
  path.join(repoRoot, "src/agents/bash-tools.exec.ts"),
  path.join(repoRoot, "src/agents/bash-tools.process.ts"),
  path.join(repoRoot, "src/auto-reply/reply/acp-projector.ts"),
];

const args = new Set(process.argv.slice(2));
const shouldCheck = args.has("--check");
const shouldWrite = args.has("--write");

if (!shouldCheck && !shouldWrite) {
  console.error("Usage: node --import tsx scripts/tool-display.ts --check|--write");
  process.exit(1);
}

const expected = serializeToolDisplayConfig();
ensureCoreToolCoverage();

if (shouldWrite) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, expected);
  process.stdout.write(`wrote ${path.relative(repoRoot, outputPath)}\n`);
  process.exit(0);
}

if (!fs.existsSync(path.dirname(outputPath))) {
  process.stdout.write(
    `skip tool-display snapshot check; missing ${path.relative(repoRoot, path.dirname(outputPath))}\n`,
  );
  process.exit(0);
}

if (!fs.existsSync(outputPath)) {
  console.error(
    `missing generated snapshot: ${path.relative(repoRoot, outputPath)}\nrun: pnpm tool-display:write`,
  );
  process.exit(1);
}

const actual = fs.readFileSync(outputPath, "utf8");
if (actual !== expected) {
  console.error(
    `tool-display snapshot is stale: ${path.relative(repoRoot, outputPath)}\nrun: pnpm tool-display:write`,
  );
  process.exit(1);
}

process.stdout.write("tool-display snapshot is up to date\n");

function ensureCoreToolCoverage() {
  const toolNames = new Set<string>();
  for (const sourcePath of toolSources) {
    collectToolNamesFromFile(sourcePath, toolNames);
  }
  for (const entry of fs.readdirSync(path.join(repoRoot, "src/agents/tools"))) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
      continue;
    }
    collectToolNamesFromFile(path.join(repoRoot, "src/agents/tools", entry), toolNames);
  }
  const missing = [...toolNames].filter((name) => !TOOL_DISPLAY_CONFIG.tools[name]).toSorted();
  if (missing.length > 0) {
    console.error(
      `tool-display metadata missing for runtime tools: ${missing.join(", ")}\nupdate: src/agents/tool-display-config.ts`,
    );
    process.exit(1);
  }
}

function collectToolNamesFromFile(sourcePath: string, names: Set<string>) {
  const source = fs.readFileSync(sourcePath, "utf8");
  for (const match of source.matchAll(/\bname:\s*"([A-Za-z0-9_-]+)"/g)) {
    const name = match[1]?.trim();
    if (name) {
      names.add(name);
    }
  }
}

function serializeToolDisplayConfig(config: ToolDisplayConfig = TOOL_DISPLAY_CONFIG): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runQaSuiteCommand } from "./cli.runtime.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = process.argv[2];
const scenarioIds = process.argv.slice(3);

if (!outputDir || scenarioIds.length === 0) {
  throw new Error("suite process fixture requires an output directory and scenario ids");
}

try {
  await runQaSuiteCommand({
    repoRoot,
    outputDir: path.relative(repoRoot, outputDir),
    providerMode: "mock-openai",
    scenarioIds,
    concurrency: 4,
  });
} catch (error) {
  process.stderr.write(`${formatErrorMessage(error)}\n`);
  process.exitCode = 1;
}

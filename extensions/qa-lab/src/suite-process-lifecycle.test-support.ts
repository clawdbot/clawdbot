import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runQaSuite } from "./suite-launch.runtime.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputDir = process.argv[2];
const scenarioIds = process.argv.slice(3);

if (!outputDir || scenarioIds.length === 0) {
  throw new Error("suite process fixture requires an output directory and scenario ids");
}

try {
  const result = await runQaSuite({
    repoRoot,
    outputDir: path.relative(repoRoot, outputDir),
    providerMode: "mock-openai",
    scenarioIds,
    concurrency: 4,
  });
  const failed = result.result.scenarios.filter((scenario) => scenario.status !== "pass");
  if (failed.length > 0) {
    throw new Error(`suite process fixture failed ${failed.length} scenario(s)`);
  }
} catch (error) {
  process.stderr.write(`${formatErrorMessage(error)}\n`);
  process.exitCode = 1;
}

import { pathToFileURL } from "node:url";

export function enablePrivateQaScriptEnv(env: NodeJS.ProcessEnv = process.env) {
  env.OPENCLAW_BUILD_PRIVATE_QA = "1";
  env.OPENCLAW_ENABLE_PRIVATE_QA_CLI = "1";
  env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "0";
}

export function resolveQaE2eOutputPath(argv: readonly string[] = process.argv.slice(2)) {
  return argv[0]?.trim() || ".artifacts/qa-e2e/self-check.md";
}

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  enablePrivateQaScriptEnv();
  const { runQaE2eSelfCheck } = await import("../extensions/qa-lab/api.js");
  const result = await runQaE2eSelfCheck({ outputPath: resolveQaE2eOutputPath(argv) });
  process.stdout.write(`QA self-check report: ${result.outputPath}\n`);
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  await main();
}

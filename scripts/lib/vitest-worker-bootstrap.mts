import { fileURLToPath, pathToFileURL } from "node:url";
import { runWithFailedTrailer } from "./failed-trailer.mts";
import type { VitestWorkerDescriptor } from "./vitest-worker-artifacts.mts";

const descriptorKey = Symbol.for("openclaw.vitest.compiled-subprocess-descriptor");
const bootstrapProcess = process as NodeJS.Process & {
  [descriptorKey]?: VitestWorkerDescriptor;
};

export function getVitestWorkerDescriptor(): VitestWorkerDescriptor | undefined {
  return bootstrapProcess[descriptorKey];
}

// Private argv keeps the generation out of config hashes and inherited Node
// preloads. Vitest itself still parses the original CLI arguments.
if (import.meta.main) {
  void runWithFailedTrailer("vitest", async () => {
    const [directory, cli, ...args] = process.argv.slice(2);
    if (!directory || !cli) {
      throw new Error("Compiled subprocess bootstrap requires a directory and Vitest CLI");
    }
    bootstrapProcess[descriptorKey] = { directory };
    const cliUrl = pathToFileURL(cli);
    process.argv = [process.argv[0]!, fileURLToPath(cliUrl), ...args];
    await import(cliUrl.href);
  });
}

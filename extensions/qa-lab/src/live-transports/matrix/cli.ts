import type { Command } from "commander";
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";

type MatrixQaCliRuntime = typeof import("./cli.runtime.js");

const loadMatrixQaCliRuntime = createLazyCliRuntimeLoader<MatrixQaCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function runQaMatrix(opts: LiveTransportQaCommandOptions) {
  const runtime = await loadMatrixQaCliRuntime();
  await runtime.runQaMatrixCommand(opts);
}

export const matrixQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "matrix",
    description: "Run the Docker-backed Matrix live QA lane against a disposable homeserver",
    outputDirHelp: "Matrix QA artifact directory",
    scenarioHelp: "Run only the named Matrix QA scenario (repeatable)",
    sutAccountHelp: "Temporary Matrix account id inside the QA gateway config",
    run: runQaMatrix,
  });

export function registerMatrixQaCli(qa: Command) {
  matrixQaCliRegistration.register(qa);
}

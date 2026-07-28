// Qa Lab plugin module implements Matrix live transport CLI behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createLiveTransportQaAdapterFactory,
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  loadLiveTransportQaSuiteRuntime,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { resolveMatrixQaScenarioIds } from "./profiles.js";

const DISABLE_MATRIX_QA_FORCE_EXIT_ENV = "OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT";

const loadMatrixQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));

async function flushProcessStream(stream: NodeJS.WriteStream) {
  if (stream.destroyed || !stream.writable) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}

async function exitMatrixQaCommand(code: number): Promise<never> {
  // Matrix crypto native handles can outlive the QA run after normal cleanup.
  // This single-shot command must exit deterministically once artifacts flush.
  await Promise.all([flushProcessStream(process.stdout), flushProcessStream(process.stderr)]);
  process.exit(code);
}

async function runQaMatrix(opts: LiveTransportQaCommandOptions) {
  const run = async () => {
    const runtime = await loadLiveTransportQaSuiteRuntime();
    await runtime.runLiveTransportQaSuiteCommand({
      channelId: "matrix",
      credentialMode: "env-only",
      defaultProviderMode: "live-frontier",
      envCredentialReason: "its homeserver is disposable and local.",
      laneLabel: "Matrix",
      options: opts,
      selectScenarioIds: resolveMatrixQaScenarioIds,
    });
  };
  if (process.env[DISABLE_MATRIX_QA_FORCE_EXIT_ENV] === "1") {
    await run();
    return;
  }

  let exitCode: number;
  try {
    await run();
    exitCode = process.exitCode === undefined || process.exitCode === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${formatErrorMessage(error)}\n`);
    exitCode = 1;
  }
  await exitMatrixQaCommand(exitCode);
}

export const matrixQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "matrix",
    adapterFactory: createLiveTransportQaAdapterFactory({
      id: "matrix",
      // Every worker owns a uniquely named disposable homeserver, Gateway, and state tree.
      isolatesInstances: true,
      async create(context) {
        return (await loadMatrixQaAdapterRuntime()).createMatrixQaTransportAdapter(context);
      },
    }),
    defaultProviderMode: "live-frontier",
    description: "Run the Docker-backed Matrix live QA lane against a disposable homeserver",
    outputDirHelp: "Matrix QA artifact directory",
    profileHelp:
      "QA Lab Matrix profile: all, fast, release, transport, media, e2ee-smoke, e2ee-deep, or e2ee-cli (default: all)",
    scenarioHelp: "Run only the named Matrix QA scenario (repeatable)",
    failFastHelp: "Stop after the first failed Matrix QA scenario",
    sutAccountHelp: "Temporary Matrix account id inside the QA gateway config",
    run: runQaMatrix,
  });

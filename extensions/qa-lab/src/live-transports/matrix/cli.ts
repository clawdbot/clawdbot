// Qa Lab plugin module implements Matrix live transport CLI behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";

const DISABLE_MATRIX_QA_FORCE_EXIT_ENV = "OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT";
const MATRIX_QA_REPO_FLOW_SCENARIO_IDS = [
  "channel-chat-baseline",
  "channel-canary",
  "channel-dm-group-routing",
  "channel-mention-gating",
  "channel-sender-allowlist",
  "channel-top-level-reply-shape",
  "channel-secondary-conversation-isolation",
  "channel-multi-actor-ordering",
  "thread-follow-up",
  "thread-isolation",
  "thread-reply-override",
  "dm-shared-session",
  "dm-per-room-session",
] as const;

const loadMatrixQaCliRuntime = createLazyCliRuntimeLoader<typeof import("./cli.runtime.js")>(
  () => import("./cli.runtime.js"),
);
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
  const run = async () => await (await loadMatrixQaCliRuntime()).runQaMatrixCommand(opts);
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

const matrixQaAdapterFactory: NonNullable<LiveTransportQaCliRegistration["adapterFactory"]> = {
  id: "matrix",
  scenarioIds: MATRIX_QA_REPO_FLOW_SCENARIO_IDS,
  matches: ({ channelId, driver }) => driver === "live" && channelId === "matrix",
  async create(context) {
    return await (await loadMatrixQaAdapterRuntime()).createMatrixQaTransportAdapter(context);
  },
};

export const matrixQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "matrix",
    adapterFactory: matrixQaAdapterFactory,
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

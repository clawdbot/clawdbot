import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { withProgress } from "../cli/progress.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { CrestodianAssistantPlanner } from "./assistant.js";
import { resolveCrestodianOperation } from "./dialogue.js";
import {
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  type CrestodianCommandDeps,
} from "./operations.js";
import { formatCrestodianOverview, loadCrestodianOverview } from "./overview.js";

type CrestodianInteractiveRunner = (
  opts: RunCrestodianOptions,
  runtime: RuntimeEnv,
) => Promise<void>;

export type RunCrestodianOptions = {
  message?: string;
  yes?: boolean;
  json?: boolean;
  interactive?: boolean;
  onReady?: () => void;
  deps?: CrestodianCommandDeps;
  planWithAssistant?: CrestodianAssistantPlanner;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  runInteractiveTui?: CrestodianInteractiveRunner;
};

async function runOneShot(
  input: string,
  runtime: RuntimeEnv,
  opts: RunCrestodianOptions,
): Promise<void> {
  const operation = await resolveCrestodianOperation(input, runtime, opts);
  await executeCrestodianOperation(operation, runtime, {
    approved: opts.yes === true || !isPersistentCrestodianOperation(operation),
    deps: opts.deps,
  });
}

export async function runCrestodian(
  opts: RunCrestodianOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (opts.json) {
    const overview = await loadCrestodianOverview();
    writeRuntimeJson(runtime, overview);
    return;
  }

  if (opts.message?.trim()) {
    const overview = await withProgress(
      {
        label: "Loading Crestodian overview…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      },
      async () => await loadCrestodianOverview(),
    );
    runtime.log(formatCrestodianOverview(overview));
    runtime.log("");
    await runOneShot(opts.message, runtime, opts);
    return;
  }

  const interactive = opts.interactive ?? true;
  const input = opts.input ?? defaultStdin;
  const output = opts.output ?? defaultStdout;
  const inputIsTty = (input as { isTTY?: boolean }).isTTY === true;
  const outputIsTty = (output as { isTTY?: boolean }).isTTY === true;
  if (!interactive || !inputIsTty || !outputIsTty) {
    runtime.error("Crestodian needs an interactive TTY. Use --message for one command.");
    return;
  }

  const runInteractiveTui =
    opts.runInteractiveTui ?? (await import("./tui-backend.js")).runCrestodianTui;
  opts.onReady?.();
  await runInteractiveTui(opts, runtime);
}

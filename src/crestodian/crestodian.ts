// Crestodian CLI runner selects JSON, one-shot, or interactive setup-helper mode.
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { withProgress } from "../cli/progress.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { CrestodianAssistantPlanner } from "./assistant.js";
import { resolveCrestodianOperation } from "./dialogue.js";
import { CrestodianInferenceUnavailableError } from "./inference-error.js";
import {
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  parseCrestodianOperation,
  type CrestodianCommandDeps,
  type CrestodianOperation,
} from "./operations.js";
import {
  formatCrestodianOverview,
  loadCrestodianOverview,
  type CrestodianOverview,
} from "./overview.js";
import {
  resolveCrestodianVerifiedInferenceRoute,
  type CrestodianVerifiedInferenceBinding,
} from "./verified-inference.js";

/**
 * CLI entry point for Crestodian.
 *
 * This module chooses JSON, one-shot, or interactive TUI mode and delegates all
 * command parsing/execution to dialogue and operation modules.
 */
type CrestodianInteractiveRunner = (
  opts: RunCrestodianOptions,
  runtime: RuntimeEnv,
) => Promise<void>;

/** Options accepted by the Crestodian command runner. */
export type RunCrestodianOptions = {
  message?: string;
  yes?: boolean;
  json?: boolean;
  interactive?: boolean;
  /** "onboarding" swaps the greeting for the first-run setup proposal. */
  welcomeVariant?: "onboarding";
  /** Workspace override for the proposed first-run setup (from --workspace). */
  setupWorkspace?: string;
  onReady?: () => void;
  deps?: CrestodianCommandDeps;
  formatOverview?: (overview: CrestodianOverview) => string;
  loadOverview?: typeof loadCrestodianOverview;
  planWithAssistant?: CrestodianAssistantPlanner;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  runInteractiveTui?: CrestodianInteractiveRunner;
  /** Exact live-tested route supplied by the inference gate. */
  readonly verifiedInference: CrestodianVerifiedInferenceBinding;
};

/** User-supplied command options before the inference gate binds the run. */
export type CrestodianCommandOptions = Omit<RunCrestodianOptions, "verifiedInference">;

function crestodianCommandDepsFromOptions(
  opts: RunCrestodianOptions,
): CrestodianCommandDeps | undefined {
  if (!opts.deps && !opts.formatOverview && !opts.loadOverview) {
    return undefined;
  }
  return {
    ...opts.deps,
    ...(opts.formatOverview ? { formatOverview: opts.formatOverview } : {}),
    ...(opts.loadOverview ? { loadOverview: opts.loadOverview } : {}),
  };
}

async function requireVerifiedInference(opts: RunCrestodianOptions): Promise<void> {
  if (!opts.verifiedInference) {
    throw new CrestodianInferenceUnavailableError("conversation");
  }
  try {
    const route = await resolveCrestodianVerifiedInferenceRoute(opts.verifiedInference, opts.deps);
    if (route) {
      return;
    }
  } catch (error) {
    throw new CrestodianInferenceUnavailableError("conversation", [error]);
  }
  throw new CrestodianInferenceUnavailableError("conversation");
}

async function requirePersistentApplyInference(
  opts: RunCrestodianOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  if (!opts.verifiedInference) {
    throw new CrestodianInferenceUnavailableError("conversation");
  }
  try {
    const { resolveCrestodianInferenceForPersistentApply } = await import("./setup-inference.js");
    const route = await resolveCrestodianInferenceForPersistentApply({
      binding: opts.verifiedInference,
      runtime,
      deps: opts.deps,
    });
    if (route) {
      return;
    }
  } catch (error) {
    if (error instanceof CrestodianInferenceUnavailableError) {
      throw error;
    }
    throw new CrestodianInferenceUnavailableError("conversation", [error]);
  }
  throw new CrestodianInferenceUnavailableError("conversation");
}

async function runOneShot(
  operation: CrestodianOperation,
  runtime: RuntimeEnv,
  opts: RunCrestodianOptions,
): Promise<void> {
  if (operation.kind === "none" && operation.message === "") {
    return;
  }
  // The planner may take long enough for the verified route to change. Never
  // apply its result under a different inference owner.
  await requireVerifiedInference(opts);
  await executeCrestodianOperation(operation, runtime, {
    approved: opts.yes === true || !isPersistentCrestodianOperation(operation),
    deps: crestodianCommandDepsFromOptions(opts),
    beforePersistentApply: async () => {
      await requirePersistentApplyInference(opts, runtime);
    },
  });
}

/** Run Crestodian in JSON, one-shot message, or interactive TUI mode. */
export async function runCrestodian(
  opts: RunCrestodianOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const binding = opts?.verifiedInference;
  if (!binding) {
    throw new CrestodianInferenceUnavailableError("conversation");
  }
  // Hold one immutable authority snapshot for the whole run. A caller that
  // mutates its input object cannot swap inference owners between planning and apply.
  const boundOpts: RunCrestodianOptions = { ...opts, verifiedInference: binding };
  await requireVerifiedInference(boundOpts);
  if (boundOpts.json) {
    const overview = await (boundOpts.loadOverview ?? loadCrestodianOverview)();
    writeRuntimeJson(runtime, overview);
    return;
  }

  if (boundOpts.message?.trim()) {
    const parsed = parseCrestodianOperation(boundOpts.message);
    if (parsed.kind === "overview") {
      await runOneShot(parsed, runtime, boundOpts);
      return;
    }
    // Show local context before an assistant interprets fuzzy input. Reuse the
    // same snapshot for planning so reply-only plans do not print before it.
    const overview = await withProgress(
      {
        label: "Loading Crestodian overview…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      },
      async () => await (boundOpts.loadOverview ?? loadCrestodianOverview)(),
    );
    runtime.log((boundOpts.formatOverview ?? formatCrestodianOverview)(overview));
    runtime.log("");
    const operation = await resolveCrestodianOperation(boundOpts.message, runtime, {
      ...boundOpts,
      loadOverview: async () => overview,
    });
    await runOneShot(operation, runtime, boundOpts);
    return;
  }

  if (boundOpts.interactive === false) {
    const overview = await (boundOpts.loadOverview ?? loadCrestodianOverview)();
    runtime.log((boundOpts.formatOverview ?? formatCrestodianOverview)(overview));
    return;
  }

  const input = boundOpts.input ?? defaultStdin;
  const output = boundOpts.output ?? defaultStdout;
  const inputIsTty = (input as { isTTY?: boolean }).isTTY === true;
  const outputIsTty = (output as { isTTY?: boolean }).isTTY === true;
  if (!inputIsTty || !outputIsTty) {
    // Without a TTY, Crestodian cannot safely ask for confirmation; require --message instead.
    runtime.error("Crestodian needs an interactive TTY. Use --message for one command.");
    runtime.exit(1);
    return;
  }

  const runInteractiveTui =
    boundOpts.runInteractiveTui ?? (await import("./tui-backend.js")).runCrestodianTui;
  boundOpts.onReady?.();
  await runInteractiveTui(boundOpts, runtime);
}

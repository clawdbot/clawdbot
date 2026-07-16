// OpenClaw CLI runner selects JSON, one-shot, or interactive setup-helper mode.
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { withProgress } from "../cli/progress.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { SystemAgentAssistantPlanner } from "./assistant.js";
import { resolveSystemAgentOperation } from "./dialogue.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  parseSystemAgentOperation,
  type SystemAgentCommandDeps,
  type SystemAgentOperation,
} from "./operations.js";
import {
  formatSystemAgentOverview,
  loadSystemAgentOverview,
  type SystemAgentOverview,
} from "./overview.js";
import {
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
} from "./verified-inference.js";

/**
 * CLI entry point for OpenClaw.
 *
 * This module chooses JSON, one-shot, or interactive TUI mode and delegates all
 * command parsing/execution to dialogue and operation modules.
 */
type SystemAgentInteractiveRunner = (
  opts: RunSystemAgentOptions,
  runtime: RuntimeEnv,
) => Promise<void>;

/** Options accepted by the OpenClaw command runner. */
export type RunSystemAgentOptions = {
  message?: string;
  yes?: boolean;
  json?: boolean;
  interactive?: boolean;
  /** "onboarding" swaps the greeting for the first-run setup proposal. */
  welcomeVariant?: "onboarding";
  /** Workspace override for the proposed first-run setup (from --workspace). */
  setupWorkspace?: string;
  onReady?: () => void;
  deps?: SystemAgentCommandDeps;
  formatOverview?: (overview: SystemAgentOverview) => string;
  loadOverview?: typeof loadSystemAgentOverview;
  planWithAssistant?: SystemAgentAssistantPlanner;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  runInteractiveTui?: SystemAgentInteractiveRunner;
  /** Exact live-tested route supplied by the inference gate. */
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
};

/** User-supplied command options before the inference gate binds the run. */
export type SystemAgentCommandOptions = Omit<RunSystemAgentOptions, "verifiedInference">;

function systemAgentCommandDepsFromOptions(
  opts: RunSystemAgentOptions,
): SystemAgentCommandDeps | undefined {
  if (!opts.deps && !opts.formatOverview && !opts.loadOverview) {
    return undefined;
  }
  return {
    ...opts.deps,
    ...(opts.formatOverview ? { formatOverview: opts.formatOverview } : {}),
    ...(opts.loadOverview ? { loadOverview: opts.loadOverview } : {}),
  };
}

async function requireVerifiedInference(opts: RunSystemAgentOptions): Promise<void> {
  if (!opts.verifiedInference) {
    throw new SystemAgentInferenceUnavailableError("conversation");
  }
  try {
    const route = await resolveSystemAgentVerifiedInferenceRoute(opts.verifiedInference, opts.deps);
    if (route) {
      return;
    }
  } catch (error) {
    throw new SystemAgentInferenceUnavailableError("conversation", [error]);
  }
  throw new SystemAgentInferenceUnavailableError("conversation");
}

async function requirePersistentApplyInference(
  opts: RunSystemAgentOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  if (!opts.verifiedInference) {
    throw new SystemAgentInferenceUnavailableError("conversation");
  }
  try {
    const { resolvePersistentApplyInference } = await import("./setup-inference.js");
    const route = await resolvePersistentApplyInference({
      binding: opts.verifiedInference,
      runtime,
      deps: opts.deps,
    });
    if (route) {
      return;
    }
  } catch (error) {
    if (error instanceof SystemAgentInferenceUnavailableError) {
      throw error;
    }
    throw new SystemAgentInferenceUnavailableError("conversation", [error]);
  }
  throw new SystemAgentInferenceUnavailableError("conversation");
}

async function runOneShot(
  operation: SystemAgentOperation,
  runtime: RuntimeEnv,
  opts: RunSystemAgentOptions,
): Promise<void> {
  if (operation.kind === "none" && operation.message === "") {
    return;
  }
  // The planner may take long enough for the verified route to change. Never
  // apply its result under a different inference owner.
  await requireVerifiedInference(opts);
  await executeSystemAgentOperation(operation, runtime, {
    approved: opts.yes === true || !isPersistentSystemAgentOperation(operation),
    deps: systemAgentCommandDepsFromOptions(opts),
    beforePersistentApply: async () => {
      await requirePersistentApplyInference(opts, runtime);
    },
  });
}

/** Run OpenClaw in JSON, one-shot message, or interactive TUI mode. */
export async function runSystemAgent(
  opts: RunSystemAgentOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const binding = opts?.verifiedInference;
  if (!binding) {
    throw new SystemAgentInferenceUnavailableError("conversation");
  }
  // Hold one immutable authority snapshot for the whole run. A caller that
  // mutates its input object cannot swap inference owners between planning and apply.
  const boundOpts: RunSystemAgentOptions = { ...opts, verifiedInference: binding };
  await requireVerifiedInference(boundOpts);
  if (boundOpts.json) {
    const overview = await (boundOpts.loadOverview ?? loadSystemAgentOverview)();
    writeRuntimeJson(runtime, overview);
    return;
  }

  if (boundOpts.message?.trim()) {
    const parsed = parseSystemAgentOperation(boundOpts.message);
    if (parsed.kind === "overview") {
      await runOneShot(parsed, runtime, boundOpts);
      return;
    }
    // Show local context before an assistant interprets fuzzy input. Reuse the
    // same snapshot for planning so reply-only plans do not print before it.
    const overview = await withProgress(
      {
        label: "Loading OpenClaw overview…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      },
      async () => await (boundOpts.loadOverview ?? loadSystemAgentOverview)(),
    );
    runtime.log((boundOpts.formatOverview ?? formatSystemAgentOverview)(overview));
    runtime.log("");
    const operation = await resolveSystemAgentOperation(boundOpts.message, runtime, {
      ...boundOpts,
      loadOverview: async () => overview,
    });
    await runOneShot(operation, runtime, boundOpts);
    return;
  }

  if (boundOpts.interactive === false) {
    const overview = await (boundOpts.loadOverview ?? loadSystemAgentOverview)();
    runtime.log((boundOpts.formatOverview ?? formatSystemAgentOverview)(overview));
    return;
  }

  const input = boundOpts.input ?? defaultStdin;
  const output = boundOpts.output ?? defaultStdout;
  const inputIsTty = (input as { isTTY?: boolean }).isTTY === true;
  const outputIsTty = (output as { isTTY?: boolean }).isTTY === true;
  if (!inputIsTty || !outputIsTty) {
    // Without a TTY, OpenClaw cannot safely ask for confirmation; require --message instead.
    runtime.error("OpenClaw needs an interactive TTY. Use --message for one command.");
    runtime.exit(1);
    return;
  }

  const runInteractiveTui =
    boundOpts.runInteractiveTui ?? (await import("./tui-backend.js")).runSystemAgentTui;
  boundOpts.onReady?.();
  await runInteractiveTui(boundOpts, runtime);
}

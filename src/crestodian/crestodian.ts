import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import readline from "node:readline/promises";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import {
  planCrestodianCommandWithConfiguredModel,
  type CrestodianAssistantPlan,
  type CrestodianAssistantPlanner,
} from "./assistant.js";
import {
  executeCrestodianOperation,
  describeCrestodianPersistentOperation,
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

export type RunCrestodianOptions = {
  message?: string;
  yes?: boolean;
  json?: boolean;
  interactive?: boolean;
  deps?: CrestodianCommandDeps;
  planWithAssistant?: CrestodianAssistantPlanner;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
};

function approvalQuestion(operation: CrestodianOperation): string {
  return `Apply this operation: ${describeCrestodianPersistentOperation(operation)}?`;
}

function isYes(input: string): boolean {
  return /^(y|yes|apply|do it|approved?)$/i.test(input.trim());
}

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

async function runResolvedOperation(
  operation: CrestodianOperation,
  runtime: RuntimeEnv,
  opts: RunCrestodianOptions,
): Promise<{ exitsInteractive: boolean; nextInput?: string }> {
  const result = await executeCrestodianOperation(operation, runtime, {
    approved: opts.yes === true || !isPersistentCrestodianOperation(operation),
    deps: opts.deps,
  });
  return {
    exitsInteractive: result.exitsInteractive === true,
    nextInput: result.nextInput,
  };
}

async function resolveCrestodianOperation(
  input: string,
  runtime: RuntimeEnv,
  opts: RunCrestodianOptions,
): Promise<CrestodianOperation> {
  const operation = parseCrestodianOperation(input);
  if (!shouldAskAssistant(input, operation)) {
    return operation;
  }
  const overview = await loadCrestodianOverview();
  const planner = opts.planWithAssistant ?? planCrestodianCommandWithConfiguredModel;
  const plan = await planner({ input, overview });
  if (!plan) {
    return operation;
  }
  const planned = parseCrestodianOperation(plan.command);
  if (planned.kind === "none") {
    return operation;
  }
  logAssistantPlan(runtime, plan, overview);
  return planned;
}

function shouldAskAssistant(input: string, operation: CrestodianOperation): boolean {
  if (operation.kind !== "none") {
    return false;
  }
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed === "quit" || trimmed === "exit") {
    return false;
  }
  return true;
}

function logAssistantPlan(
  runtime: RuntimeEnv,
  plan: CrestodianAssistantPlan,
  overview: CrestodianOverview,
): void {
  const modelLabel = plan.modelLabel ?? overview.defaultModel ?? "configured model";
  runtime.log(`[crestodian] planner: ${modelLabel}`);
  if (plan.reply) {
    runtime.log(plan.reply);
  }
  runtime.log(`[crestodian] interpreted: ${plan.command}`);
}

export async function runCrestodian(
  opts: RunCrestodianOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const overview = await loadCrestodianOverview();
  if (opts.json) {
    writeRuntimeJson(runtime, overview);
    return;
  }
  runtime.log(formatCrestodianOverview(overview));
  runtime.log("");
  runtime.log(
    "Say: status, doctor, health, gateway status, restart gateway, agents, models, set default model <provider/model>, talk to agent, audit, or quit.",
  );

  if (opts.message?.trim()) {
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

  const rl = readline.createInterface({ input, output });
  let pending: CrestodianOperation | null = null;
  try {
    for (;;) {
      const answer = await rl.question("crestodian> ");
      if (pending) {
        if (isYes(answer)) {
          const result = await executeCrestodianOperation(pending, runtime, {
            approved: true,
            deps: opts.deps,
          });
          pending = null;
          if (result.exitsInteractive) {
            break;
          }
          continue;
        }
        runtime.log("Skipped. No barnacles on config today.");
        pending = null;
        continue;
      }
      const operation = await resolveCrestodianOperation(answer, runtime, opts);
      if (isPersistentCrestodianOperation(operation) && !opts.yes) {
        runtime.log(approvalQuestion(operation));
        pending = operation;
        continue;
      }
      const result = await runResolvedOperation(operation, runtime, opts);
      if (result.exitsInteractive) {
        break;
      }
      if (result.nextInput?.trim()) {
        const followUp = await resolveCrestodianOperation(result.nextInput, runtime, opts);
        if (isPersistentCrestodianOperation(followUp) && !opts.yes) {
          runtime.log(approvalQuestion(followUp));
          pending = followUp;
          continue;
        }
        const followUpResult = await runResolvedOperation(followUp, runtime, opts);
        if (followUpResult.exitsInteractive) {
          break;
        }
      }
    }
  } finally {
    rl.close();
  }
}

import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../src/agents/agent-run-terminal-outcome.js";
// Standalone proof process for the subagent background-completion boundary
// (pr131735). It installs the real gateway fatal unhandled-rejection handler,
// drives the real completion runtime with injected durable failures, and
// reports whether the process survives the scenario that pre-fix reached
// process.exit(1) through the fatal fallthrough.
import { createSubagentRegistryCompletionRuntime } from "../../src/agents/subagents/registry/subagent-registry-completion-runtime.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { installUnhandledRejectionHandler } from "../../src/infra/unhandled-rejections.js";

installUnhandledRejectionHandler();

const record: SubagentRunRecord = {
  runId: "proof-run",
  childSessionKey: "agent:main:subagent-proof-run",
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: "proof task",
  cleanup: "delete",
  createdAt: 0,
  execution: {
    status: "terminal",
    endedAt: 1_000,
    outcome: { status: "error", error: "boom" },
  },
};

const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
const runtime = createSubagentRegistryCompletionRuntime({
  runs: new Map([["proof-run", record]]),
  resumed: new Set<string>(),
  retryTimers: new Set<ReturnType<typeof setTimeout>>(),
  // Both attempts fail, so the attempt callback reaches the resume path — the
  // exact escape route past the attempt's own try blocks.
  completeSubagentRun: async () => {
    throw new Error("injected durable completion failure");
  },
  scheduleSweep: () => {},
  resumeRun: () => {
    throw new Error("injected resume failure");
  },
  warn: (message, meta) => {
    warnings.push({ message, meta });
  },
});

runtime.pendingLifecycle.scheduleError({ runId: "proof-run", endedAt: 900, error: "boom" });

// Real timers: the grace scheduler fires the detached completion boundary the
// same way the live gateway does, so an escaped rejection reaches the fatal
// handler installed above instead of a Vitest-only reporter.
setTimeout(() => {
  const verdict = {
    warningMessages: warnings.map((warning) => warning.message),
    escapedRejectionLogged: warnings.some(
      (warning) => warning.message === "failed to complete subagent run in background",
    ),
    processAliveAfterRejection: true,
  };
  console.info(`PROOF_VERDICT ${JSON.stringify(verdict)}`);
  process.exit(0);
}, AGENT_RUN_TERMINAL_RETRY_GRACE_MS + 2_000);

import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { QaBusState } from "./bus-state.js";
import { createQaTransportAdapter, type QaTransportId } from "./qa-transport-registry.js";
import { renderQaMarkdownReport } from "./report.js";
import { runQaScenario, type QaScenarioResult } from "./scenario.js";
import { createQaSelfCheckScenario } from "./self-check-scenario.js";

export type QaSelfCheckResult = {
  outputPath: string;
  report: string;
  checks: Array<{ name: string; status: "pass" | "fail"; details?: string }>;
  scenarioResult: QaScenarioResult;
};

export function resolveQaSelfCheckOutputPath(params?: { outputPath?: string; repoRoot?: string }) {
  if (params?.outputPath) {
    return params.outputPath;
  }
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  return path.join(repoRoot, ".artifacts", "qa-e2e", "self-check.md");
}

export async function runQaSelfCheckAgainstState(params: {
  state: QaBusState;
  cfg: OpenClawConfig;
  transportId?: QaTransportId;
  outputPath?: string;
  repoRoot?: string;
  notes?: string[];
}): Promise<QaSelfCheckResult> {
  const startedAt = new Date();
  const transport = createQaTransportAdapter({
    id: params.transportId ?? "qa-channel",
    state: params.state,
  });
  params.state.reset();
  const scenarioResult = await runQaScenario(createQaSelfCheckScenario(), {
    state: params.state,
    performAction: async (action, args) =>
      await transport.handleAction({
        action,
        args,
        cfg: params.cfg,
        accountId: transport.accountId,
      }),
  });
  const checks = [
    {
      name: "QA self-check scenario",
      status: scenarioResult.status,
      details: `${scenarioResult.steps.filter((step) => step.status === "pass").length}/${scenarioResult.steps.length} steps passed`,
    },
  ] satisfies Array<{ name: string; status: "pass" | "fail"; details?: string }>;
  const finishedAt = new Date();
  const snapshot = params.state.getSnapshot();
  const timeline = snapshot.events.map((event) => {
    switch (event.kind) {
      case "thread-created":
        return `${event.cursor}. ${event.kind} ${event.thread.conversationId}/${event.thread.id}`;
      case "reaction-added":
        return `${event.cursor}. ${event.kind} ${event.message.id} ${event.emoji}`;
      default:
        return `${event.cursor}. ${event.kind} ${"message" in event ? event.message.id : ""}`.trim();
    }
  });
  const report = renderQaMarkdownReport({
    title: "OpenClaw QA E2E Self-Check",
    startedAt,
    finishedAt,
    checks,
    scenarios: [
      {
        name: scenarioResult.name,
        status: scenarioResult.status,
        details: scenarioResult.details,
        steps: scenarioResult.steps,
      },
    ],
    timeline,
    notes: params.notes ?? [
      "Vertical slice: qa-channel + qa-lab bus + private debugger surface.",
      "Docker orchestration, matrix runs, and auto-fix loops remain follow-up work.",
    ],
  });

  const outputPath = resolveQaSelfCheckOutputPath({
    outputPath: params.outputPath,
    repoRoot: params.repoRoot,
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, report, "utf8");

  return {
    outputPath,
    report,
    checks,
    scenarioResult,
  };
}

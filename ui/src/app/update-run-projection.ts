import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { UPDATE_RUN_PHASES } from "../../../packages/gateway-protocol/src/update-run-vocabulary.js";
import type { UpdateRunRecord, UpdateRunStep } from "../../../src/infra/update-run-record.ts";
import { renderUpdateRunReport } from "../../../src/infra/update-run-report.ts";
import { t } from "../i18n/index.ts";

type OracleState = "pass" | "warn" | "fail" | "pending";

export function projectUpdateRun(run: UpdateRunRecord, connected = true) {
  const terminal = run.status !== "running";
  const report = renderUpdateRunReport(run);
  const currentIndex = UPDATE_RUN_PHASES.indexOf(run.phase);
  const phases = UPDATE_RUN_PHASES.flatMap((phase, index) => {
    const recorded = run.steps.find((step) => step.step === phase);
    if (phase === "repairing" && !recorded && phase !== run.phase) {
      return [];
    }
    let status: UpdateRunStep["status"] = recorded?.status ?? "pending";
    if (!recorded) {
      if (phase === "finished" && terminal) {
        status =
          run.status === "succeeded"
            ? "completed"
            : run.status === "skipped"
              ? "skipped"
              : "failed";
      } else if (phase === run.phase) {
        status = "in_progress";
      } else if (terminal || index < currentIndex) {
        // A phase absent from the durable timeline was not performed, even on success.
        status = "skipped";
      }
    }
    return [{ step: phase, status, label: t(`updates.run.phase.${phase}`) }];
  });
  // Notice receipts share the bounded ledger but are delivery bookkeeping, not update work.
  const steps = run.steps.filter(
    (step) =>
      !step.step.startsWith("notice:") && !UPDATE_RUN_PHASES.some((phase) => phase === step.step),
  );
  const detailStep =
    run.steps.findLast((step) => step.status === "in_progress" && step.detail) ??
    run.steps.findLast((step) => step.detail);
  const details = detailStep
    ? sliceUtf16Safe(detailStep.detail ?? "", -4096)
        .split(/\r?\n/u)
        .slice(-80)
        .join("\n")
    : "";
  const facts = run.verification;
  const booleanState = (value: boolean | undefined): OracleState =>
    value === undefined ? (terminal ? "warn" : "pending") : value ? "pass" : "fail";
  const oracles = [
    { name: "service", state: booleanState(facts.serviceRunning) },
    { name: "version", state: booleanState(facts.versionMatch) },
    {
      name: "plugins",
      state: booleanState(
        facts.pluginErrors === undefined ? undefined : facts.pluginErrors.length === 0,
      ),
    },
    { name: "channels", state: booleanState(facts.channelsReady) },
    {
      name: "inference",
      state:
        facts.inferenceProbe === "skipped" || facts.inferenceProbe === "unavailable"
          ? "warn"
          : booleanState(
              facts.inferenceProbe === undefined ? undefined : facts.inferenceProbe === "passed",
            ),
    },
  ] as const;
  const completed = phases.filter((phase) => phase.status === "completed").length;
  const total = phases.filter((phase) => phase.status !== "skipped").length;
  return {
    report,
    terminal,
    headline:
      !connected &&
      !terminal &&
      (run.phase === "activating" || run.phase === "restarting" || run.phase === "verifying")
        ? t("updates.run.restarting")
        : report.headline,
    compactLabel: t("updates.run.progress", { completed: String(completed), total: String(total) }),
    phases,
    steps,
    detailStep: detailStep?.step,
    details,
    oracles,
  };
}

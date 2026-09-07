import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  name: string;
  if?: string;
  run?: string;
  uses?: string;
  "continue-on-error"?: boolean;
};

const workflow = parse(readFileSync(".github/workflows/linux-app.yml", "utf8"));
const linuxSteps: Step[] = workflow.jobs.build.steps;
const macosSteps: Step[] = workflow.jobs["test-macos"].steps;
const packagingSteps = [
  "Stage AppImage GStreamer plugins",
  "Prepare pinned AppImage tools",
  "Build Linux companion bundles",
  "Finalize AppImage",
  "Test native first-run setup and failed Gateway startup",
  "Test packaged AppImage runtime",
  "Upload bundles",
];

describe("Linux App validation routing", () => {
  it.each(["pull_request", "workflow_dispatch"])(
    "keeps native tests required and selects packaging only for manual validation: %s",
    (eventName) => {
      const selected = (steps: Step[]) =>
        steps.filter(
          (step) =>
            !step.if ||
            runInNewContext(step.if, {
              github: { event_name: eventName },
              failure: () => false,
            }),
        );
      const linux = selected(linuxSteps);
      const macos = selected(macosSteps);
      expect(workflow.jobs.build.if).toBeUndefined();
      expect(workflow.jobs["test-macos"].if).toBeUndefined();
      expect(workflow.jobs.build["continue-on-error"]).toBeUndefined();
      expect(workflow.jobs["test-macos"]["continue-on-error"]).toBeUndefined();
      for (const step of [...linuxSteps, ...macosSteps]) {
        expect(step["continue-on-error"], step.name).toBeUndefined();
      }
      expect(linux.map((step) => step.run)).toContain("cargo +stable fmt --check");
      for (const steps of [linux, macos]) {
        expect(steps.map((step) => step.run)).toContain(
          "cargo +stable test --locked --all-targets",
        );
      }
      expect(
        linux.find((step) => step.name === "Test packaged runtime ABI scanner")?.run,
      ).toContain("-s apps/linux/tests -p 'test_packaged_runtime_smoke.py'");
      for (const name of packagingSteps) {
        expect(
          linuxSteps.some((step) => step.name === name),
          name,
        ).toBe(true);
        expect(
          linux.some((step) => step.name === name),
          name,
        ).toBe(eventName === "workflow_dispatch");
      }
      if (eventName === "pull_request") {
        expect(linux.some((step) => step.uses?.startsWith("actions/upload-artifact@"))).toBe(false);
      }
    },
  );

  it("retains both first-run cases and failure evidence for manual validation", () => {
    const firstRun = linuxSteps.find(
      (step) => step.name === "Test native first-run setup and failed Gateway startup",
    );
    expect(firstRun?.run?.match(/python3 apps\/linux\/tests\/first_run\.py/gu)).toHaveLength(2);
    expect(firstRun?.run).toContain("--local-start-failure");
    for (const [name, id] of [
      ["Upload first-run failure log", "first-run"],
      ["Upload packaged runtime failure evidence", "packaged-runtime"],
    ]) {
      expect(linuxSteps.find((step) => step.name === name)?.if).toBe(
        `github.event_name == 'workflow_dispatch' && failure() && steps.${id}.outcome == 'failure'`,
      );
    }
  });
});

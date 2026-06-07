// Openclaw Performance Workflow tests cover openclaw performance workflow script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/openclaw-performance.yml";

type WorkflowStep = {
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function findStep(name: string): WorkflowStep {
  const steps = readWorkflow().jobs?.kova?.steps ?? [];
  const step = steps.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

describe("OpenClaw performance workflow", () => {
  it("uses the clawgrit reports token for every report repo push path", () => {
    const prepare = findStep("Prepare clawgrit reports checkout");
    const publish = findStep("Publish to clawgrit reports");

    expect(prepare.env?.CLAWGRIT_REPORTS_TOKEN).toBe("${{ secrets.CLAWGRIT_REPORTS_TOKEN }}");
    expect(publish.env?.CLAWGRIT_REPORTS_TOKEN).toBe("${{ secrets.CLAWGRIT_REPORTS_TOKEN }}");
    expect(prepare.run).toContain(
      'remote add origin "https://x-access-token:${CLAWGRIT_REPORTS_TOKEN}@github.com/openclaw/clawgrit-reports.git"',
    );
    expect(publish.run).toContain(
      'remote set-url origin "https://x-access-token:${CLAWGRIT_REPORTS_TOKEN}@github.com/openclaw/clawgrit-reports.git"',
    );
    expect(publish.run).toContain('git -C "$reports_root" push origin HEAD:main');
  });

  it("keeps optional clawgrit report publishing bounded", () => {
    const prepare = findStep("Prepare clawgrit reports checkout");
    const publish = findStep("Publish to clawgrit reports");

    expect(prepare.run).toContain('echo "ready=false" >> "$GITHUB_OUTPUT"');
    expect(prepare.run).toContain("timeout 60s git");
    expect(prepare.run).toContain("timeout 120s git");
    expect(prepare.run).toContain('echo "ready=true" >> "$GITHUB_OUTPUT"');
    expect(publish.if).toContain("steps.clawgrit_reports.outputs.ready == 'true'");
    expect(publish.run).toContain("timeout 120s git");
  });

  it("requires the shared Kova report gate before tolerating partial verdicts", () => {
    const runKova = findStep("Run Kova");

    expect(runKova.run).toContain(
      'node "$PERFORMANCE_HELPER_DIR/scripts/lib/kova-report-gate.mjs" "$report_json"',
    );
    expect(runKova.run).not.toContain("report.summary?.statuses ?? {}");
  });

  it("fails selected live Kova lanes when live auth is missing", () => {
    const configureAuth = findStep("Configure live OpenAI auth");
    const runKova = findStep("Run Kova");

    expect(configureAuth.if).toContain("matrix.live == 'true'");
    expect(configureAuth.env?.OPENAI_API_KEY).toBe("${{ secrets.OPENAI_API_KEY }}");
    expect(configureAuth.run).toContain('if [[ -z "${OPENAI_API_KEY:-}" ]]; then');
    expect(configureAuth.run).toContain("cannot run without live evidence");
    expect(configureAuth.run).toContain("exit 1");
    expect(configureAuth.run).not.toContain("will be skipped");
    expect(runKova.run).not.toContain('echo "skipped=true" >> "$GITHUB_OUTPUT"');
  });

  it("requires Kova evidence before uploading selected lane artifacts", () => {
    const validateEvidence = findStep("Validate Kova evidence");
    const upload = findStep("Upload Kova artifacts");

    expect(validateEvidence.if).toContain("always()");
    expect(validateEvidence.if).toContain("steps.lane.outputs.run == 'true'");
    expect(validateEvidence.run).toContain('"$REPORT_DIR" -maxdepth 1 -type f -name');
    expect(validateEvidence.run).toContain('"$BUNDLE_DIR/bundle.json"');
    expect(validateEvidence.run).toContain('"$SUMMARY_DIR/${LANE_ID}.md"');
    expect(validateEvidence.run).toContain("exit 1");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });
});

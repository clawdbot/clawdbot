import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const source = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
const workflow = parse(source) as {
  jobs: Record<
    string,
    { if?: string; steps: Array<Record<string, unknown>>; "timeout-minutes"?: number }
  >;
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
};

function step(job: string, name: string) {
  const match = workflow.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!match) {
    throw new Error(`missing workflow step: ${job}/${name}`);
  }
  return match;
}

describe("full release metadata checkouts", () => {
  it.each([
    {
      job: "resolve_target",
      targetCheckout: "Checkout target package manifest",
      imports: [
        "release-tooling-identity.mjs",
        "full-release-candidate-contract.mjs",
        "full-release-validation-policy.mjs",
      ],
    },
    {
      job: "evidence_reuse",
      targetCheckout: "Checkout target SHA",
      imports: ["release-ci-summary.mjs"],
    },
  ])("runs $job tooling from only its sparse files", ({ job, targetCheckout, imports }) => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-sparse-"));
    try {
      for (const name of ["Checkout trusted workflow helper", targetCheckout]) {
        const checkout = step(job, name).with as Record<string, unknown>;
        expect(checkout["sparse-checkout-cone-mode"]).toBe(false);
        const paths = String(checkout["sparse-checkout"] ?? "")
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean);
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          const destination = join(root, String(checkout.path), path);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(path, destination);
        }
      }

      const runNode = (args: string[], cwd = root) =>
        execFileSync(process.execPath, args, {
          cwd,
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
        });
      expect(
        runNode([
          "--input-type=module",
          "-e",
          imports.map((file) => `await import("./workflow/scripts/${file}");`).join("\n"),
        ]),
      ).toBe("");
      if (job === "evidence_reuse") {
        const setup = step(job, "Setup Node.js");
        const steps = workflow.jobs[job]!.steps;
        expect(steps.indexOf(setup)).toBeLessThan(
          steps.indexOf(step(job, "Find reusable validation evidence")),
        );
        expect(setup.env).toMatchObject({ REQUESTED_NODE_VERSION: "24.x" });
        execFileSync("bash", ["-c", String(setup.run)], {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            ...(setup.env as Record<string, string>),
            // Keep this sparse-file proof offline on every supported test runtime.
            REQUESTED_NODE_VERSION: process.versions.node,
            PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
            NODE_OPTIONS: "",
            GITHUB_PATH: join(root, "github-path"),
          },
        });
        expect(
          runNode(
            [join(root, "workflow/scripts/release-preflight.mjs"), "--macos-versions-only"],
            join(root, "target"),
          ),
        ).toContain("macOS app version metadata OK");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("full release same-parent recovery workflow", () => {
  it("has no continuation payload and dispatches child work only on attempt one", () => {
    expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty("continuation_plan_json");
    for (const job of [
      "docker_runtime_assets_preflight",
      "candidate_acquisition",
      "normal_ci",
      "plugin_prerelease_independent",
      "plugin_prerelease_candidate",
      "release_checks_independent",
      "release_checks_candidate",
      "npm_telegram",
      "performance",
    ]) {
      expect(String(workflow.jobs[job]?.if), job).toContain("github.run_attempt == 1");
    }
    expect(source).not.toContain("continuationSource");
    expect(source).not.toContain("continuation_plan_json");
  });

  it("restores the immutable attempt-one plan instead of rebuilding child identity", () => {
    const cache = step("release_execution_plan", "Cache immutable release execution plan");
    const restore = step(
      "release_execution_plan",
      "Restore immutable release execution plan artifact",
    );
    const upload = step("release_execution_plan", "Upload immutable release execution plan");
    expect(cache).toMatchObject({
      id: "plan_cache",
      "continue-on-error": true,
      with: {
        key: "full-release-execution-plan-v1-${{ github.run_id }}",
        path: "${{ runner.temp }}/full-release-execution-plan",
      },
    });
    expect(cache.with).not.toHaveProperty("fail-on-cache-miss");
    expect(restore).toMatchObject({
      if: "${{ always() && github.run_attempt != 1 && steps.plan_cache.outputs.cache-hit != 'true' }}",
      with: {
        "github-token": "${{ github.token }}",
        name: "full-release-execution-plan-${{ github.run_id }}",
        path: "${{ runner.temp }}/full-release-execution-plan",
        "run-id": "${{ github.run_id }}",
      },
    });
    expect(upload.with).toMatchObject({
      name: "full-release-execution-plan-${{ github.run_id }}",
      overwrite: true,
    });
    for (const job of ["release_decision", "diagnostic_drain", "summary"]) {
      expect(step(job, "Download immutable release execution plan").with).toMatchObject({
        name: "full-release-execution-plan-${{ github.run_id }}",
      });
    }
  });

  it("validates final manifest attempts against the diagnostic drain", () => {
    expect(step("summary", "Validate release validation manifest").env).toMatchObject({
      DIAGNOSTIC_DRAIN_PATH:
        "${{ runner.temp }}/full-release-diagnostics/full-release-diagnostic-manifest.json",
    });
  });

  it("gives final candidate verification enough time for its bounded API retries", () => {
    expect(workflow.jobs.summary?.["timeout-minutes"]).toBe(10);
  });

  it("keeps failure cancellation explicit while diagnostic drain never cancels", () => {
    expect(step("release_decision", "Evaluate release decision").env).toMatchObject({
      FAIL_FAST: "${{ inputs.fail_fast }}",
      FULL_RELEASE_STATE_MODE: "decision",
    });
    expect(step("diagnostic_drain", "Drain child diagnostics").env).toMatchObject({
      FAIL_FAST: "false",
      FULL_RELEASE_STATE_MODE: "drain",
    });
  });
});

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const source = readFileSync(".github/workflows/full-release-validation.yml", "utf8");
type Workflow = {
  jobs: Record<
    string,
    { if?: string; steps: Array<Record<string, unknown>>; "timeout-minutes"?: number }
  >;
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
};
const workflow = parse(source) as Workflow;

function step(job: string, name: string, owner = workflow) {
  const match = owner.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!match) {
    throw new Error(`missing workflow step: ${job}/${name}`);
  }
  return match;
}

function sparsePaths(checkout: Record<string, unknown>) {
  const value = checkout["sparse-checkout"];
  if (typeof value !== "string") {
    throw new TypeError("sparse-checkout must be a string");
  }
  return value
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
}

function checkoutPath(checkout: Record<string, unknown>) {
  if (checkout.path === undefined) {
    return "";
  }
  if (typeof checkout.path !== "string") {
    throw new TypeError("checkout path must be a string");
  }
  return checkout.path;
}

describe("full release metadata checkouts", () => {
  it.each([
    {
      job: "resolve_target",
      checkout: "Checkout trusted workflow helper",
      entrypoint: "release-tooling-identity.mjs",
    },
    {
      job: "evidence_reuse",
      checkout: "Checkout trusted workflow helper",
      entrypoint: "release-ci-summary.mjs",
      extraPath: ".github/actions/setup-pnpm-store-cache",
    },
    {
      job: "release_execution_plan",
      checkout: "Checkout release execution plan tooling",
      entrypoint: "full-release-validation-state.mjs",
    },
    {
      job: "release_decision",
      checkout: "Checkout release decision tooling",
      entrypoint: "full-release-validation-state.mjs",
    },
    {
      job: "diagnostic_drain",
      checkout: "Checkout diagnostic drain tooling",
      entrypoint: "full-release-validation-state.mjs",
    },
    {
      job: "summary",
      checkout: "Checkout release state verifier",
      entrypoint: "full-release-candidate-reuse.mjs",
    },
  ])(
    "runs $job tooling from the complete scripts tree",
    ({ job, checkout, entrypoint, extraPath }) => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-release-sparse-"));
      try {
        const toolingCheckout = step(job, checkout).with as Record<string, unknown>;
        expect(toolingCheckout["sparse-checkout-cone-mode"]).toBe(false);
        const paths = sparsePaths(toolingCheckout);
        expect(paths).toEqual(extraPath ? ["scripts", extraPath] : ["scripts"]);

        const checkoutRoot = join(root, checkoutPath(toolingCheckout));
        cpSync("scripts", join(checkoutRoot, "scripts"), { recursive: true });
        if (extraPath) {
          cpSync(extraPath, join(checkoutRoot, extraPath), { recursive: true });
        }

        const runNode = (args: string[], cwd = root) =>
          execFileSync(process.execPath, args, {
            cwd,
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
          });
        expect(
          runNode(
            ["--input-type=module", "-e", `await import("./scripts/${entrypoint}");`],
            checkoutRoot,
          ),
        ).toBe("");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps target metadata narrow and runs the macOS preflight from the tooling tree", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-sparse-"));
    try {
      const targetCheckouts = [
        ["resolve_target", "Checkout target package manifest"],
        ["evidence_reuse", "Checkout target SHA"],
      ] as const;
      for (const [job, name] of targetCheckouts) {
        const checkout = step(job, name).with as Record<string, unknown>;
        expect(checkout["sparse-checkout-cone-mode"]).toBe(false);
        const paths = sparsePaths(checkout);
        expect(paths).not.toContain("scripts");
        for (const path of paths) {
          const destination = join(root, checkoutPath(checkout), path);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(path, destination);
        }
      }

      const toolingCheckout = step("evidence_reuse", "Checkout trusted workflow helper")
        .with as Record<string, unknown>;
      cpSync("scripts", join(root, checkoutPath(toolingCheckout), "scripts"), { recursive: true });
      cpSync(
        ".github/actions/setup-pnpm-store-cache",
        join(root, checkoutPath(toolingCheckout), ".github/actions/setup-pnpm-store-cache"),
        { recursive: true },
      );

      const setup = step("evidence_reuse", "Setup Node.js");
      const steps = workflow.jobs.evidence_reuse!.steps;
      expect(steps.indexOf(setup)).toBeLessThan(
        steps.indexOf(step("evidence_reuse", "Find reusable validation evidence")),
      );
      expect(setup.env).toMatchObject({ REQUESTED_NODE_VERSION: "24.x" });
      execFileSync("bash", ["-c", String(setup.run)], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          ...(setup.env as Record<string, string>),
          // Keep this sparse-checkout proof offline on every supported test runtime.
          REQUESTED_NODE_VERSION: process.versions.node,
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
          NODE_OPTIONS: "",
          GITHUB_PATH: join(root, "github-path"),
        },
      });
      expect(
        execFileSync(
          process.execPath,
          [join(root, "workflow/scripts/release-preflight.mjs"), "--macos-versions-only"],
          {
            cwd: join(root, "target"),
            encoding: "utf8",
            timeout: 10_000,
            env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
          },
        ),
      ).toContain("macOS app version metadata OK");
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
    for (const [job, dispatch] of [
      ["prepare_npm_package", "Dispatch immutable npm artifact producer"],
      ["prepare_docker_release", "Dispatch immutable Docker artifact producer"],
      ["candidate_acquisition", "Dispatch immutable validation candidate producer"],
    ] as const) {
      expect(String(workflow.jobs[job]?.if), job).not.toContain("github.run_attempt");
      expect(step(job, dispatch).if).toBe("github.run_attempt == 1");
      expect(step(job, "Recover original artifact producer").if).toBeUndefined();
    }
    expect(String(workflow.jobs.qualify_npm_package?.if)).not.toContain("github.run_attempt");
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

// Ci Workflow Guards tests cover ci workflow guards script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function readCiWorkflow() {
  return parse(readFileSync(".github/workflows/ci.yml", "utf8"));
}

function readCriticalQualityWorkflow() {
  return readFileSync(".github/workflows/codeql-critical-quality.yml", "utf8");
}

describe("ci workflow guards", () => {
  it("kills timed manual checkout fetches after the grace period", () => {
    const workflowPaths = [
      ".github/workflows/ci.yml",
      ".github/workflows/workflow-sanity.yml",
      ".github/workflows/ci-check-testbox.yml",
      ".github/workflows/ci-check-arm-testbox.yml",
      ".github/workflows/ci-build-artifacts-testbox.yml",
      ".github/workflows/crabbox-hydrate.yml",
    ];

    for (const workflowPath of workflowPaths) {
      const workflow = readFileSync(workflowPath, "utf8");
      const fetchTimeouts = workflow.match(
        /timeout --signal=TERM[^\n]* 30s git(?: -C "(?:\$workdir|\$GITHUB_WORKSPACE|clawhub-source)")?/g,
      );

      expect(fetchTimeouts?.length, workflowPath).toBeGreaterThan(0);
      expect(
        fetchTimeouts?.every((line) =>
          line.startsWith("timeout --signal=TERM --kill-after=10s 30s git"),
        ),
        workflowPath,
      ).toBe(true);
    }
  });

  it("bounds shared base commit fetches", () => {
    const action = readFileSync(".github/actions/ensure-base-commit/action.yml", "utf8");

    expect(action).toContain("fetch_base_ref()");
    expect(action).toContain("timeout --signal=TERM --kill-after=10s 30s git");
    expect(action).toContain("-c protocol.version=2");
    expect(action).not.toContain("if ! git fetch --no-tags");
  });

  it("bounds early unauthenticated checkout fetches", () => {
    const workflow = readCiWorkflow();

    for (const jobName of ["preflight", "security-fast", "skills-python"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find((step) => step.name === "Checkout");

      expect(checkoutStep.run, jobName).toContain(
        'timeout --signal=TERM --kill-after=10s 30s git -C "$GITHUB_WORKSPACE"',
      );
      expect(checkoutStep.run, jobName).toContain("for attempt in 1 2 3");
      expect(checkoutStep.run, jobName).toContain("timed out on attempt $attempt; retrying");
      expect(checkoutStep.run, jobName).not.toContain("if timeout --signal=TERM");
      expect(checkoutStep.run, jobName).toContain("-c protocol.version=2");
      const expectedDepth = jobName === "preflight" ? 2 : 1;
      expect(checkoutStep.run, jobName).toContain(
        `fetch --no-tags --prune --no-recurse-submodules --depth=${expectedDepth} origin`,
      );
      if (jobName !== "skills-python") {
        expect(checkoutStep.run, jobName).toContain('if [ "$fetch_status" = "124" ]');
        expect(checkoutStep.run, jobName).toContain("timed out");
      }
      expect(checkoutStep.run, jobName).not.toContain(
        'git -C "$GITHUB_WORKSPACE" fetch --no-tags --depth=1',
      );
    }
  });

  it("bounds platform checkout fetches without GNU timeout", () => {
    const workflow = readCiWorkflow();

    for (const jobName of ["checks-windows", "macos-node", "macos-swift"]) {
      const checkoutStep = workflow.jobs[jobName].steps.find((step) => step.name === "Checkout");

      expect(checkoutStep.run, jobName).toContain("fetch_checkout_ref()");
      expect(checkoutStep.run, jobName).toContain("fetch_timeout_seconds=90");
      expect(checkoutStep.run, jobName).toContain("-c protocol.version=2");
      expect(checkoutStep.run, jobName).toContain(
        "fetch --no-tags --prune --no-recurse-submodules --depth=1 origin",
      );
      expect(checkoutStep.run, jobName).toContain(
        'if [ "$elapsed" -ge "$fetch_timeout_seconds" ]; then',
      );
      expect(checkoutStep.run, jobName).toContain('kill -TERM "$fetch_pid"');
      expect(checkoutStep.run, jobName).toContain('kill -KILL "$fetch_pid"');
      expect(checkoutStep.run, jobName).not.toContain(
        'git -C "$GITHUB_WORKSPACE" fetch --no-tags --depth=1',
      );
    }
  });

  it("bounds the Windows Crabbox hydrate main fetch", () => {
    const workflow = readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8");

    expect(workflow).toContain("$fetchInfo = New-Object System.Diagnostics.ProcessStartInfo");
    expect(workflow).toContain('$fetchInfo.FileName = "git"');
    expect(workflow).toContain("$fetchInfo.WorkingDirectory = $repo");
    expect(workflow).toContain("$fetchInfo.UseShellExecute = $false");
    expect(workflow).not.toContain("$fetchInfo.RedirectStandardOutput = $true");
    expect(workflow).not.toContain("$fetchInfo.RedirectStandardError = $true");
    expect(workflow).toContain(
      "--no-tags --no-progress --prune --no-recurse-submodules --depth=50",
    );
    expect(workflow).toContain("$fetch = New-Object System.Diagnostics.Process");
    expect(workflow).toContain("$fetch.StartInfo = $fetchInfo");
    expect(workflow).toContain("$fetch.WaitForExit(30000)");
    expect(workflow).toContain("$fetch.Kill()");
    expect(workflow).not.toContain("StandardOutput.ReadToEnd()");
    expect(workflow).not.toContain("StandardError.ReadToEnd()");
    expect(workflow).toContain('throw "git fetch failed with exit code $($fetch.ExitCode)"');
    expect(workflow).toContain('throw "git fetch timed out after 30 seconds"');
    expect(workflow).not.toContain(
      'git fetch --no-tags --depth=50 origin "+refs/heads/main:refs/remotes/origin/main"',
    );
  });

  it("runs dependency policy guards in PR CI preflight", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const preflightGuards = workflow.slice(
      workflow.indexOf("guards)"),
      workflow.indexOf("shrinkwrap)"),
    );
    const shrinkwrapGuards = workflow.slice(
      workflow.indexOf("shrinkwrap)"),
      workflow.indexOf("prod-types)"),
    );

    expect(workflow).toContain("check-guards");
    expect(workflow).toContain("check-shrinkwrap");
    expect(shrinkwrapGuards).toContain("pnpm deps:shrinkwrap:check");
    expect(preflightGuards).toContain("pnpm deps:patches:check");
  });

  it("does not rebuild Control UI after build:ci-artifacts", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const buildDistStep = buildArtifactSteps.find((step) => step.name === "Build dist");

    expect(buildDistStep.run).toBe("pnpm build:ci-artifacts");
    expect(buildArtifactSteps.map((step) => step.name)).not.toContain("Build Control UI");
    expect(buildArtifactSteps.some((step) => step.run === "pnpm ui:build")).toBe(false);
  });

  it("restores the dist build cache before building and saves only cache misses", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const stepNames = buildArtifactSteps.map((step) => step.name);
    const restoreStep = buildArtifactSteps.find((step) => step.name === "Restore dist build cache");
    const buildDistStep = buildArtifactSteps.find((step) => step.name === "Build dist");
    const saveStep = buildArtifactSteps.find((step) => step.name === "Save dist build cache");

    expect(stepNames.indexOf("Restore dist build cache")).toBeLessThan(
      stepNames.indexOf("Build dist"),
    );
    expect(stepNames.indexOf("Build dist")).toBeLessThan(
      stepNames.indexOf("Pack built runtime artifacts"),
    );
    expect(stepNames.indexOf("Run built artifact checks")).toBeLessThan(
      stepNames.indexOf("Save dist build cache"),
    );
    expect(restoreStep.uses).toBe("actions/cache/restore@v5");
    expect(buildDistStep.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(saveStep.uses).toBe("actions/cache/save@v5");
    expect(saveStep.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(saveStep.with.key).toBe("${{ steps.dist_build_cache.outputs.cache-primary-key }}");
    expect(restoreStep.with.path).toContain("dist/");
    expect(restoreStep.with.path).toContain("dist-runtime/");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/.bundle.hash");
    expect(restoreStep.with.path).toContain("extensions/*/src/host/**/*.bundle.js");
    expect(buildArtifactSteps.map((step) => step.name)).not.toContain("Cache dist build");
  });

  it("fails and retries quiet Node test shard stalls quickly", () => {
    const workflow = readCiWorkflow();
    const nodeTestJob = workflow.jobs["checks-node-core-test-nondist-shard"];
    const runStep = nodeTestJob.steps.find((step) => step.name === "Run Node test shard");

    expect(nodeTestJob["timeout-minutes"]).toBe(60);
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("300000");
    expect(runStep.env.OPENCLAW_VITEST_NO_OUTPUT_RETRY).toBe("1");
    expect(runStep.env.OPENCLAW_TEST_PROJECTS_PARALLEL).toBe("2");
  });

  it("uploads a CI timing summary after the run lanes finish", () => {
    const workflow = readCiWorkflow();
    const timingJob = workflow.jobs["ci-timings-summary"];

    expect(timingJob.permissions).toMatchObject({ actions: "read", contents: "read" });
    expect(timingJob.needs).toEqual([
      "preflight",
      "security-fast",
      "pnpm-store-warmup",
      "build-artifacts",
      "checks-fast-core",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
      "checks-node-compat",
      "checks-node-core-test-nondist-shard",
      "check-shard",
      "check-additional-shard",
      "check-docs",
      "skills-python",
      "checks-windows",
      "macos-node",
      "macos-swift",
      "android",
    ]);
    expect(timingJob.if).toContain("always()");
    expect(timingJob.if).toContain("!cancelled()");

    const checkoutStep = timingJob.steps.find(
      (step) => step.name === "Checkout timing summary helper",
    );
    expect(checkoutStep.uses).toBe("actions/checkout@v6");
    expect(checkoutStep.with.ref).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || needs.preflight.outputs.checkout_revision || github.sha }}",
    );
    expect(checkoutStep.with["persist-credentials"]).toBe(false);

    const writeStep = timingJob.steps.find((step) => step.name === "Write CI timing summary");
    expect(writeStep.env).toMatchObject({ GH_TOKEN: "${{ github.token }}" });
    expect(writeStep.run).toContain(
      'node scripts/ci-run-timings.mjs "$GITHUB_RUN_ID" --limit 25 > ci-timings-summary.txt',
    );
    expect(writeStep.run).toContain('cat ci-timings-summary.txt >> "$GITHUB_STEP_SUMMARY"');

    const uploadStep = timingJob.steps.find((step) => step.name === "Upload CI timing summary");
    expect(uploadStep.uses).toBe("actions/upload-artifact@v7");
    expect(uploadStep.with).toMatchObject({
      name: "ci-timings-summary",
      path: "ci-timings-summary.txt",
      "retention-days": 14,
    });
  });

  it("keeps push docs validation ClawHub-backed", () => {
    const workflow = readFileSync(".github/workflows/docs.yml", "utf8");

    expect(workflow).toContain("repository: openclaw/clawhub");
    expect(workflow).toContain("path: clawhub-source");
    expect(workflow).toContain(
      "OPENCLAW_DOCS_SYNC_CLAWHUB_REPO: ${{ github.workspace }}/clawhub-source",
    );
  });

  it("keeps network CodeQL off unrelated source-only refactors", () => {
    const workflow = readCriticalQualityWorkflow();
    const networkConfig = readFileSync(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
      "utf8",
    );
    const networkSelector = workflow.slice(
      workflow.indexOf(".github/codeql/codeql-network-runtime-boundary-critical-quality.yml"),
      workflow.indexOf("network-runtime-boundary:"),
    );
    const broadCodeqlSelector = workflow.slice(
      workflow.indexOf(".github/codeql/*|.github/workflows/codeql-critical-quality.yml"),
      workflow.indexOf("src/**/*.test.ts|src/**/*.test.tsx"),
    );

    expect(broadCodeqlSelector).not.toContain("network_runtime=true");
    expect(networkSelector).toContain(
      ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
    );
    expect(networkSelector).not.toContain("src/*.ts|src/**/*.ts");
    expect(networkSelector).not.toContain("extensions/*.ts|extensions/**/*.ts");
    expect(networkSelector).toContain("src/infra/net/*");
    expect(networkSelector).toContain("src/infra/ssh-tunnel.ts");
    expect(networkSelector).toContain("packages/net-policy/src/*");
    expect(networkConfig).not.toContain("\n  - src\n");
    expect(networkConfig).not.toContain("\n  - extensions\n");
    expect(networkConfig).toContain("\n  - src/infra/net\n");
    expect(networkConfig).toContain("\n  - packages/net-policy/src\n");
    expect(workflow).toContain("Fast PR network boundary diff scan");
    expect(workflow).toContain("Network runtime boundary-sensitive added lines");
    expect(workflow).toContain("if: ${{ github.event_name != 'pull_request' }}");
  });
});

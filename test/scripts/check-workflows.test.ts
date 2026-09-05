// Check Workflows tests cover check workflows script behavior.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createGatewayTaskSupervisorProbe } from "../../src/daemon/schtasks.task-supervisor.native-test-support.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const scriptPath = path.resolve("scripts/check-workflows.mts");
const tempDirs: string[] = [];

type WorkflowStep = {
  name: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string | number | boolean>;
  with?: Record<string, string | number | boolean>;
  "timeout-minutes"?: number;
  "continue-on-error"?: boolean | string;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  "runs-on": string;
  "continue-on-error"?: boolean | string;
  steps: WorkflowStep[];
};

function readWindowsProbe() {
  const workflow = parse(readFileSync(".github/workflows/windows-testbox-probe.yml", "utf8")) as {
    on: {
      workflow_dispatch: {
        inputs: Record<string, { default: unknown; type: string; description: string }>;
      };
    };
    jobs: Record<string, WorkflowJob>;
  };
  const native = Object.values(workflow.jobs).find((job) =>
    job.steps.some((step) => step.id === "native_schtasks"),
  );
  const probe = workflow.jobs.probe;
  if (!probe || !native) {
    throw new Error("Windows probe must declare both headless CI and native proof jobs");
  }
  return { workflow, probe, native };
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("check-workflows", () => {
  it("prints an actionable diagnostic when actionlint and go are unavailable", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing workflow linter");
    expect(result.stderr).toContain("install actionlint, Go");
    expect(result.stderr).toContain("011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7");
  });

  it("uses the pinned go fallback and audits all workflows with zizmor", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const markerPath = path.join(tempDir, "go-run.txt");
    const preCommitMarkerPath = path.join(tempDir, "pre-commit.txt");
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, "go"),
      [
        "#!/bin/sh",
        'if [ "$1" = "version" ]; then exit 0; fi',
        'if [ "$1" = "run" ]; then printf "%s\\n" "$*" > "$GO_FALLBACK_MARKER"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(binDir, "pre-commit"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then exit 0; fi',
        'printf "%s\\n" "$*" >> "$PRE_COMMIT_MARKER"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    for (const command of ["python3", "node"]) {
      writeFileSync(path.join(binDir, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }

    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        GO_FALLBACK_MARKER: markerPath,
        PRE_COMMIT_MARKER: preCommitMarkerPath,
        PATH: binDir,
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(markerPath, "utf8")).toContain(
      "github.com/rhysd/actionlint/cmd/actionlint@011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7",
    );
    const preCommitArgs = readFileSync(preCommitMarkerPath, "utf8");
    expect(preCommitArgs).toContain("run --config .pre-commit-config.yaml zizmor --files");
    expect(preCommitArgs).toContain(".github/workflows/ci.yml");
    expect(preCommitArgs).toContain(".github/workflows/windows-testbox-probe.yml");
  });

  it("bootstraps pinned pre-commit in a temporary Python venv when needed", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const markerPath = path.join(tempDir, "python.txt");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      path.join(binDir, "python3"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then exit 0; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ] && [ "$3" = "--version" ]; then exit 1; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then',
        '  printf "%s\\n" "$*" >> "$PRE_COMMIT_BOOTSTRAP_MARKER"',
        "  exit 0",
        "fi",
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ]; then',
        '  printf "%s\\n" "$*" >> "$PRE_COMMIT_BOOTSTRAP_MARKER"',
        "  exit 0",
        "fi",
        'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
        '  /bin/mkdir -p "$3/bin"',
        '  /bin/cp "$0" "$3/bin/python"',
        '  /bin/chmod +x "$3/bin/python"',
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDir,
        PRE_COMMIT_BOOTSTRAP_MARKER: markerPath,
      },
    });

    expect(result.status).toBe(0);
    const pythonArgs = readFileSync(markerPath, "utf8");
    expect(pythonArgs).toContain("-m pip install --disable-pip-version-check pre-commit==4.6.2");
    expect(pythonArgs).toContain(
      "-m pre_commit run --config .pre-commit-config.yaml actionlint --files",
    );
    expect(pythonArgs).toContain(
      "-m pre_commit run --config .pre-commit-config.yaml zizmor --files",
    );
  });

  it("prints the missing runtime diagnostic when Python venv support is unavailable", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      path.join(binDir, "python3"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then exit 0; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ] && [ "$3" = "--version" ]; then exit 1; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
        '  printf "%s\\n" "python venv unavailable" >&2',
        "  exit 1",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("python venv unavailable");
    expect(result.stderr).toContain("missing pre-commit runtime for actionlint");
    expect(result.stderr).toContain("Python venv support for pre-commit 4.6.2");
  });

  it("cleans the temporary Python venv before exiting on hook failure", () => {
    const tempDir = makeTempDir(tempDirs, "check-workflows-");
    const binDir = path.join(tempDir, "bin");
    const markerPath = path.join(tempDir, "venv-path.txt");
    mkdirSync(binDir);
    writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      path.join(binDir, "python3"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then exit 0; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ] && [ "$3" = "--version" ]; then exit 1; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then',
        '  /bin/mkdir -p "$3/bin"',
        '  /bin/cp "$0" "$3/bin/python"',
        '  /bin/chmod +x "$3/bin/python"',
        '  printf "%s\\n" "$3" > "$PRE_COMMIT_VENV_MARKER"',
        "  exit 0",
        "fi",
        'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then exit 0; fi',
        'if [ "$1" = "-m" ] && [ "$2" = "pre_commit" ]; then',
        '  printf "%s\\n" "hook failed" >&2',
        "  exit 13",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDir,
        PRE_COMMIT_VENV_MARKER: markerPath,
      },
    });

    expect(result.status).toBe(13);
    expect(result.stderr).toContain("hook failed");
    expect(existsSync(readFileSync(markerPath, "utf8").trim())).toBe(false);
  });

  it("keeps Windows WSL2 probe output normalized through the shared wrapper", () => {
    const workflow = readFileSync(".github/workflows/windows-testbox-probe.yml", "utf8");

    expect(workflow).toContain(
      '$import = Invoke-WslText -Arguments @("--import", "UbuntuProbe", $wslRoot, $rootfs, "--version", "2")',
    );
    expect(workflow).toContain("function Resolve-UbuntuWslRootfsUrl");
    expect(workflow).toContain('"x64" { $wslArch = "amd64" }');
    expect(workflow).toContain('"arm64" { $wslArch = "arm64" }');
    expect(workflow).toContain("ubuntu-noble-wsl-$wslArch-wsl.rootfs.tar.gz");
    expect(workflow).toContain("ubuntu_wsl_rootfs_arch=$wslArch");
    expect(workflow).toContain("-ConnectionTimeoutSeconds 15");
    expect(workflow).toContain("-OperationTimeoutSeconds 120");
    expect(workflow).toContain('Write-Host "wsl_import_exit=$($import.Code)"');
    expect(workflow).toContain("wsl2_restart_required=true");
    expect(workflow).toContain("import_ubuntu_wsl2=skipped_restart_required");
    expect(workflow).toContain("wsl_exec_skipped=restart_required");
    expect(workflow).toContain(
      '"wsl2_restart_required=$($restartRequired.ToString().ToLowerInvariant())"',
    );
    expect(workflow).toContain(
      '$exec = Invoke-WslText -Arguments @("-d", $distro, "--exec", "bash", "-lc"',
    );
    expect(workflow).toContain('Write-Host "wsl_exec_exit=$($exec.Code)"');
    expect(workflow).not.toContain("wsl.exe --import UbuntuProbe");
    expect(workflow).not.toContain("Microsoft-Hyper-V-All");
  });

  it("requests independent headless CI and native qualification without allowing either to fail", () => {
    const { workflow, probe, native } = readWindowsProbe();
    expect(workflow.on.workflow_dispatch.inputs.run_windows_ci).toMatchObject({
      description: "Run the focused Windows CI shard and native Scheduled Task proof",
      default: false,
      type: "boolean",
    });
    expect(workflow.on.workflow_dispatch.inputs.runner_label?.default).toBe(
      "blacksmith-16vcpu-windows-2025",
    );
    expect(native).not.toBe(probe);
    expect(native.if).toBe("${{ inputs.run_windows_ci }}");
    expect(native["runs-on"]).toBe("windows-2025");
    expect(probe.if).toBeUndefined();
    expect(probe["runs-on"]).toBe("${{ inputs.runner_label }}");
    for (const job of [probe, native]) {
      expect(job.needs).toBeUndefined();
      for (const entry of [job, ...job.steps]) {
        expect(entry["continue-on-error"]).toBeUndefined();
      }
    }
    const ci = probe.steps.find((step) => step.name === "Run Windows CI tests")!;
    expect(ci.if).toBe("${{ inputs.run_windows_ci }}");
    expect(ci.run).toContain("pnpm test:windows:ci");
    expect(ci.env).toMatchObject({ OPENCLAW_VITEST_MAX_WORKERS: 1 });
    expect(native.steps).not.toContainEqual(ci);
    expect(probe.steps.some((step) => step.id?.startsWith("native_"))).toBe(false);
    expect(
      probe.steps.find((step) => step.name === "Keep runner alive for SSH inspection")?.if,
    ).toBe("${{ always() && !cancelled() }}");
    expect(probe.steps.find((step) => step.name === "Enforce WSL2 requirement")?.if).toBe(
      "${{ always() && !cancelled() && inputs.require_wsl2 }}",
    );

    const isolation = native.steps[0]!;
    expect(isolation.id).toBe("native_isolation");
    expect(isolation.if).toBeUndefined();
    expect(isolation.env).toEqual({
      NATIVE_RUNNER_ENVIRONMENT: "${{ runner.environment }}",
      EXPECTED_HEAD: "${{ inputs.target_ref }}",
    });
    const preflight = native.steps[1]!;
    expect(preflight.name).toBe("Preflight native Scheduled Task session");
    expect(preflight.if).toBe(native.if);
    expect(preflight.run).toContain(
      'if (-not [Environment]::UserInteractive) {\n  throw "Native Scheduled Task proof requires an interactive Windows runner session."\n}',
    );
    for (const diagnostic of [
      "identity=",
      "session_id=",
      "user_interactive=",
      "administrator=",
      "query user",
    ]) {
      expect(preflight.run).toContain(diagnostic);
    }
    for (const name of [
      "Checkout",
      "Setup Node.js",
      "Setup pnpm",
      "Runtime versions",
      "Capture node path",
      "Install dependencies",
    ]) {
      const setup = probe.steps.find((step) => step.name === name)!;
      expect(setup).toBeDefined();
      expect(native.steps.find((step) => step.name === name)).toEqual(setup);
    }
    expect(native.steps.find((step) => step.name === "Checkout")?.with).toMatchObject({
      ref: "${{ inputs.target_ref || github.ref }}",
      "persist-credentials": false,
    });
    expect(native.steps.find((step) => step.name === "Setup Node.js")?.env).toMatchObject({
      REQUESTED_NODE_VERSION: "22.x",
    });
    expect(native.steps.find((step) => step.name === "Setup pnpm")?.uses).toBe(
      "./.github/actions/setup-pnpm-store-cache",
    );
    expect(native.steps.find((step) => step.name === "Install dependencies")?.run).toContain(
      "pnpm install --frozen-lockfile --prefer-offline",
    );
  });

  it("retains exact-source native proof and cleanup evidence even on failure", () => {
    const { native } = readWindowsProbe();
    const proof = native.steps.find((step) => step.id === "native_schtasks")!;
    const cleanup = native.steps.find((step) => step.id === "native_cleanup")!;
    const upload = native.steps.find((step) => step.id === "native_proof_upload")!;
    const remove = native.steps.find(
      (step) => step.name === "Remove retained native Scheduled Task evidence",
    )!;
    expect(proof["timeout-minutes"]).toBe(5);
    expect(proof.if).toBe(native.if);
    expect(proof.env).toMatchObject({
      EXPECTED_HEAD: "${{ inputs.target_ref }}",
      CI_WINDOWS_SCHTASKS_ROOT:
        "${{ runner.temp }}\\openclaw-schtasks-${{ github.run_id }}-${{ github.run_attempt }}",
      CI_WINDOWS_SCHTASKS_TEST_ID: "${{ github.run_id }}-${{ github.run_attempt }}",
      CI_WINDOWS_SCHTASKS_PROOF_PATH:
        "${{ github.workspace }}\\.artifacts\\windows-schtasks\\proof.json",
    });
    expect(proof.run).toContain('if [[ ! "$EXPECTED_HEAD" =~ ^[0-9a-f]{40}$ ]]; then');
    expect(proof.run).toContain('CI_WINDOWS_SCHTASKS_HEAD="$(git rev-parse HEAD)"');
    expect(proof.run).toContain('if [[ "$CI_WINDOWS_SCHTASKS_HEAD" != "$EXPECTED_HEAD" ]]; then');
    expect(proof.run).toContain("export CI_WINDOWS_SCHTASKS_HEAD");
    expect(proof.run).toContain("pnpm test:windows:schtasks:integration");
    expect(cleanup.if).toBe(
      '${{ always() && inputs.run_windows_ci && steps.native_isolation.outcome == \'success\' && contains(fromJSON(\'["success","failure","cancelled"]\'), steps.native_schtasks.outcome) }}',
    );
    expect(upload.if).toBe("${{ always() && inputs.run_windows_ci }}");
    expect(cleanup.env).toEqual({
      TEST_ID: proof.env?.CI_WINDOWS_SCHTASKS_TEST_ID,
      TEST_ROOT: proof.env?.CI_WINDOWS_SCHTASKS_ROOT,
    });
    expect(remove.env).toEqual(cleanup.env);
    expect(cleanup.run).toContain('"proof_outcome=${{ steps.native_schtasks.outcome }}"');
    expect(cleanup.run).toContain("schtasks.exe /Delete /F /TN $taskName");
    expect(cleanup.run).toContain('$service = New-Object -ComObject "Schedule.Service"');
    expect(cleanup.run).toContain('throw ($cleanupErrors -join " ")');
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/u);
    expect(upload.with?.path).toContain(".artifacts/windows-schtasks/proof.json");
    expect(upload.with?.path).toContain("windows-schtasks-isolation.json");
    expect(upload.with?.path).toContain("failure-diagnostics.json");
    expect(upload.with?.path).toContain("cleanup-summary.txt");
    expect(upload.with?.path).not.toContain("task-before-cleanup.xml");
    expect(cleanup.run).not.toContain("Copy-Item -LiteralPath $stateDir");
    expect(remove.if).toBe(
      "${{ always() && inputs.run_windows_ci && steps.native_cleanup.outcome == 'success' && steps.native_proof_upload.outcome == 'success' }}",
    );
    expect(native.steps.slice(native.steps.indexOf(proof))).toEqual([
      proof,
      cleanup,
      upload,
      remove,
    ]);
  });

  it("identifies the producer's exact native probe before emergency process-tree cleanup", () => {
    const { native } = readWindowsProbe();
    const cleanup = native.steps.find((step) => step.id === "native_cleanup")!.run;
    const probe = createGatewayTaskSupervisorProbe("probe-root");
    expect(cleanup).toContain(
      `$probePath = Join-Path $env:TEST_ROOT "${path.basename(probe.probePath)}"`,
    );
    expect(cleanup).toContain('$activePidPath = Join-Path $env:TEST_ROOT "active-pid.txt"');
    expect(cleanup).toContain('$eventsPath = Join-Path $env:TEST_ROOT "runs.txt"');
    expect(cleanup).toContain(
      '$process.CommandLine -like "*$probePath*" -and\n        $process.CommandLine -like "*$eventsPath*"',
    );
    expect(cleanup).toContain(
      'throw "Refusing to kill reused or unverifiable process id $probePid."',
    );
    expect(cleanup).toContain("taskkill.exe /F /T /PID $probePid");
    expect(cleanup).toContain("[DateTime]::UtcNow.AddSeconds(30)");
  });
});

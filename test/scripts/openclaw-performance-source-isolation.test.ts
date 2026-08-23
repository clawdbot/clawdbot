// OpenClaw source performance isolation executes the workflow's real shared-shell path.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const WORKFLOW = ".github/workflows/openclaw-performance.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkflowStep = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function findStep(name: string, job: string): WorkflowStep {
  const step = readWorkflow().jobs?.[job]?.steps?.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step as WorkflowStep;
}

describe("OpenClaw source performance isolation", () => {
  it("isolates the source performance gateway from network and scheduled work", () => {
    const workflow = readWorkflow();
    const job = workflow.jobs?.source_performance;
    const targetStepName = "Run OpenClaw source performance probes";
    const step = findStep(targetStepName, "source_performance");
    const jobSteps = job?.steps ?? [];
    const targetStepIndex = jobSteps.findIndex((candidate) => candidate.name === targetStepName);
    const run = step.run ?? "";
    const sliceStartMarker = 'gateway_home="$(mktemp -d)"';
    const sliceEndMarker = "cleanup_gateway\ntrap - EXIT";
    const sliceStart = run.indexOf(sliceStartMarker);
    const sliceEndMarkerIndex = run.indexOf(sliceEndMarker, sliceStart);
    const workflowSlice = run.slice(sliceStart, sliceEndMarkerIndex + sliceEndMarker.length);
    const cronEnv = "OPENCLAW_SKIP_CRON";
    const joinedSliceContinuations = workflowSlice.replace(/\\\s*\n/g, " ");
    const gatewayConfigHeredocTargets = joinedSliceContinuations
      .split("\n")
      .filter((line) => line.includes("<<"))
      .flatMap((line) => line.match(/\$\{?gateway_config\}?/g) ?? []);
    const configHeredocStart = workflowSlice.indexOf('cat > "$gateway_config" <<EOF');
    const configHeredocEnd = workflowSlice.indexOf("\nEOF\n", configHeredocStart);

    expect(sliceStart).toBeGreaterThanOrEqual(0);
    expect(run.lastIndexOf(sliceStartMarker)).toBe(sliceStart);
    expect(sliceEndMarkerIndex).toBeGreaterThan(sliceStart);
    expect(run.lastIndexOf(sliceEndMarker)).toBe(sliceEndMarkerIndex);
    expect(gatewayConfigHeredocTargets).toHaveLength(1);
    expect(configHeredocStart).toBeGreaterThanOrEqual(0);
    expect(configHeredocEnd).toBeGreaterThan(configHeredocStart);
    expect(
      workflowSlice.slice(configHeredocStart, configHeredocEnd).split("${catalog_refresh_config}"),
    ).toHaveLength(2);
    expect(workflowSlice.match(/OPENCLAW_SKIP_CRON/g) ?? []).toHaveLength(1);
    expect(workflowSlice.match(/OPENCLAW_SKIP_CHANNELS/g) ?? []).toHaveLength(1);

    const fixtureRoot = tempDirs.make("openclaw-performance-isolation-");
    const binDir = join(fixtureRoot, "bin");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "node"),
      `#!/bin/sh
set -eu
record_env() {
  {
    printf 'OPENCLAW_HOME=%s\\n' "\${OPENCLAW_HOME-<unset>}"
    printf 'OPENCLAW_STATE_DIR=%s\\n' "\${OPENCLAW_STATE_DIR-<unset>}"
    printf 'OPENCLAW_CONFIG_PATH=%s\\n' "\${OPENCLAW_CONFIG_PATH-<unset>}"
    printf 'OPENCLAW_GATEWAY_PORT=%s\\n' "\${OPENCLAW_GATEWAY_PORT-<unset>}"
    printf 'OPENCLAW_SKIP_CHANNELS=%s\\n' "\${OPENCLAW_SKIP_CHANNELS-<unset>}"
    printf 'OPENCLAW_SKIP_CRON=%s\\n' "\${OPENCLAW_SKIP_CRON-<unset>}"
  } > "$CAPTURE_DIR/$1.env"
}
record_argv() {
  name="$1"
  shift
  printf '%s\\n' "$@" > "$CAPTURE_DIR/$name.argv"
}
if [ "\${1-}" = "-e" ]; then
  [ -n "\${REAL_NODE-}" ] || { printf 'REAL_NODE is required\\n' >&2; exit 64; }
  exec "$REAL_NODE" "$@"
fi
if [ "\${1-}" = "dist/entry.js" ] && [ "\${2-}" = "gateway" ] && [ "\${3-}" = "run" ]; then
  record_env gateway
  record_argv gateway "$@"
  /bin/cp "$OPENCLAW_CONFIG_PATH" "$CAPTURE_DIR/gateway.config"
  printf '%s\\n' "$OPENCLAW_GATEWAY_PORT" > "$CAPTURE_DIR/gateway.port"
  trap 'printf "terminated\\n" > "$CAPTURE_DIR/gateway.terminated"; exit 0' TERM INT
  printf 'gateway-run\\n' >> "$EVENTS_FILE"
  : > "$CAPTURE_DIR/gateway.ready"
  remaining=8
  while [ "$remaining" -gt 0 ]; do
    /bin/sleep 1
    remaining=$((remaining - 1))
  done
  exit 64
fi
if [ "\${1-}" = "dist/entry.js" ] && [ "\${2-}" = "gateway" ] && [ "\${3-}" = "health" ]; then
  record_env health
  record_argv health "$@"
  /bin/cp "$OPENCLAW_CONFIG_PATH" "$CAPTURE_DIR/health.config"
  printf 'gateway-health\\n' >> "$EVENTS_FILE"
  exit 0
fi
if [ "\${1-}" = "--import" ] && [ "\${2-}" = "tsx" ]; then
  case "\${3-}" in
    *bench-cli-startup.ts) ;;
    *) exit 64 ;;
  esac
  record_env benchmark
  record_argv benchmark "$@"
  /bin/cp "$OPENCLAW_CONFIG_PATH" "$CAPTURE_DIR/benchmark.config"
  printf 'benchmark\\n' >> "$EVENTS_FILE"
  exit 0
fi
printf 'unexpected node argv:' >&2
printf ' %s' "$@" >&2
printf '\\n' >&2
exit 64
`,
    );
    writeFileSync(
      join(binDir, "cp"),
      `#!/bin/sh
set -eu
[ "$#" -eq 2 ] || exit 64
[ ! -e "$CAPTURE_DIR/readiness-copy.config" ] || exit 64
/bin/cp "$1" "$CAPTURE_DIR/readiness-copy.config"
/bin/cp "$1" "$2"
`,
    );
    writeFileSync(
      join(binDir, "curl"),
      `#!/bin/sh
set -eu
[ -s "$CAPTURE_DIR/gateway.port" ] || exit 1
port="$(cat "$CAPTURE_DIR/gateway.port")"
expected="http://127.0.0.1:$port/healthz"
found=false
for arg in "$@"; do
  [ "$arg" = "$expected" ] && found=true
done
[ "$found" = true ] || { printf 'unexpected curl argv\\n' >&2; exit 64; }
[ -f "$CAPTURE_DIR/gateway.ready" ] || exit 1
printf 'http-health\\n' >> "$EVENTS_FILE"
`,
    );
    writeFileSync(
      join(binDir, "rg"),
      `#!/bin/sh
set -eu
[ "$#" -eq 3 ] && [ "$1" = '-q' ] && [ "$2" = 'catalogRefresh:' ] && [ "$3" = 'src/config/zod-schema.core.ts' ] || {
  printf 'unexpected rg argv\\n' >&2
  exit 64
}
printf 'catalog-probe\\n' >> "$EVENTS_FILE"
exit "$RG_STATUS"
`,
    );
    chmodSync(join(binDir, "rg"), 0o755);
    chmodSync(join(binDir, "curl"), 0o755);
    chmodSync(join(binDir, "cp"), 0o755);
    chmodSync(join(binDir, "node"), 0o755);

    for (const [branch, rgStatus, expectsCatalogRefresh] of [
      ["unsupported", "1", false],
      ["supported", "0", true],
    ] as const) {
      const branchDir = join(fixtureRoot, branch);
      const captureDir = join(branchDir, "capture");
      const sourcePerfDir = join(branchDir, "source");
      const eventsFile = join(branchDir, "events.txt");
      mkdirSync(captureDir, { recursive: true });
      mkdirSync(sourcePerfDir);
      const isolatedEnv = { ...process.env };
      for (const name of [
        "OPENCLAW_SKIP_CRON",
        "OPENCLAW_SKIP_CHANNELS",
        "BASH_ENV",
        "ENV",
        "BASHOPTS",
        "SHELLOPTS",
        "CDPATH",
        "GLOBIGNORE",
        "PROMPT_COMMAND",
        "ZDOTDIR",
      ]) {
        delete isolatedEnv[name];
      }
      Object.assign(isolatedEnv, {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: branchDir,
        TMPDIR: branchDir,
        CAPTURE_DIR: captureDir,
        EVENTS_FILE: eventsFile,
        GITHUB_WORKSPACE: "/fixture/workspace",
        PERFORMANCE_HELPER_DIR: "/fixture/helpers",
        REAL_NODE: process.execPath,
        RG_STATUS: rgStatus,
        SOURCE_PERF_DIR: sourcePerfDir,
        source_runs: "2",
      });
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-c", `set -euo pipefail\n${workflowSlice}`],
        {
          cwd: fixtureRoot,
          encoding: "utf8",
          env: isolatedEnv,
          timeout: 12_000,
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);

      expect(readFileSync(eventsFile, "utf8").trim().split("\n")).toEqual([
        "catalog-probe",
        "gateway-run",
        "http-health",
        "gateway-health",
        "benchmark",
      ]);
      const gatewayConfig = readFileSync(join(captureDir, "gateway.config"), "utf8");
      const gatewayPort = readFileSync(join(captureDir, "gateway.port"), "utf8").trim();
      expect(gatewayPort).toMatch(/^[1-9][0-9]*$/);
      expect(readFileSync(join(captureDir, "readiness-copy.config"), "utf8")).toBe(gatewayConfig);
      expect(readFileSync(join(captureDir, "health.config"), "utf8")).toBe(gatewayConfig);
      expect(readFileSync(join(captureDir, "benchmark.config"), "utf8")).toBe(gatewayConfig);
      parse(gatewayConfig, { uniqueKeys: true });
      const parsedConfig = JSON.parse(gatewayConfig) as {
        models?: { catalogRefresh?: { enabled?: boolean } };
      };
      expect(parsedConfig).toMatchObject({
        agents: { defaults: { heartbeat: { every: "0m" } } },
        browser: { enabled: false },
        update: { checkOnStart: false },
        gateway: {
          mode: "local",
          port: Number(gatewayPort),
          bind: "loopback",
          auth: { mode: "none" },
          controlUi: { enabled: false },
          tailscale: { mode: "off" },
        },
        plugins: { enabled: true, entries: { browser: { enabled: false } } },
      });
      expect(JSON.stringify(parsedConfig)).not.toContain('"dreaming":');
      if (expectsCatalogRefresh) {
        expect(parsedConfig.models?.catalogRefresh?.enabled).toBe(false);
      } else {
        expect(parsedConfig.models?.catalogRefresh).toBeUndefined();
      }

      const readCapturedEnv = (name: string) =>
        Object.fromEntries(
          readFileSync(join(captureDir, `${name}.env`), "utf8")
            .trim()
            .split("\n")
            .map((line) => {
              const separator = line.indexOf("=");
              return [line.slice(0, separator), line.slice(separator + 1)];
            }),
        ) as Record<string, string>;
      const gatewayEnv = readCapturedEnv("gateway");
      const healthEnv = readCapturedEnv("health");
      const benchmarkEnv = readCapturedEnv("benchmark");
      const gatewayHome = expectDefined(gatewayEnv.OPENCLAW_HOME, "gateway home capture");
      const gatewayState = expectDefined(gatewayEnv.OPENCLAW_STATE_DIR, "gateway state capture");
      const gatewayConfigPath = expectDefined(
        gatewayEnv.OPENCLAW_CONFIG_PATH,
        "gateway config capture",
      );
      const healthHome = expectDefined(healthEnv.OPENCLAW_HOME, "readiness home capture");
      const healthState = expectDefined(healthEnv.OPENCLAW_STATE_DIR, "readiness state capture");
      const healthConfigPath = expectDefined(
        healthEnv.OPENCLAW_CONFIG_PATH,
        "readiness config capture",
      );
      expect(gatewayEnv.OPENCLAW_SKIP_CRON).toBe("1");
      expect(gatewayEnv.OPENCLAW_SKIP_CHANNELS).toBe("1");
      expect(benchmarkEnv.OPENCLAW_SKIP_CRON).toBe("<unset>");
      expect(benchmarkEnv.OPENCLAW_SKIP_CHANNELS).toBe("<unset>");
      expect(healthEnv.OPENCLAW_SKIP_CRON).toBe("<unset>");
      expect(healthEnv.OPENCLAW_SKIP_CHANNELS).toBe("<unset>");
      expect(benchmarkEnv.OPENCLAW_HOME).toBe(gatewayHome);
      expect(benchmarkEnv.OPENCLAW_STATE_DIR).toBe(gatewayState);
      expect(benchmarkEnv.OPENCLAW_CONFIG_PATH).toBe(gatewayConfigPath);
      expect(benchmarkEnv.OPENCLAW_GATEWAY_PORT).toBe(gatewayPort);
      expect(gatewayEnv.OPENCLAW_GATEWAY_PORT).toBe(gatewayPort);
      expect(healthHome).not.toBe(gatewayHome);
      expect(healthState).not.toBe(gatewayState);
      expect(healthConfigPath).not.toBe(gatewayConfigPath);
      expect(gatewayState).toBe(join(gatewayHome, ".openclaw"));
      expect(gatewayConfigPath).toBe(join(gatewayState, "openclaw.json"));
      expect(healthState).toBe(join(healthHome, ".openclaw"));
      expect(healthConfigPath).toBe(join(healthState, "openclaw.json"));

      expect(readFileSync(join(captureDir, "gateway.argv"), "utf8").trim().split("\n")).toEqual([
        "dist/entry.js",
        "gateway",
        "run",
        "--bind",
        "loopback",
        "--port",
        gatewayPort,
        "--auth",
        "none",
        "--allow-unconfigured",
        "--force",
      ]);
      expect(readFileSync(join(captureDir, "health.argv"), "utf8")).toContain(
        `dist/entry.js\ngateway\nhealth\n--port\n${gatewayPort}\n`,
      );
      expect(readFileSync(join(captureDir, "benchmark.argv"), "utf8")).toContain(
        "--import\ntsx\n/fixture/helpers/scripts/bench-cli-startup.ts\n",
      );
      expect(readFileSync(join(captureDir, "gateway.terminated"), "utf8")).toBe("terminated\n");
      expect(existsSync(gatewayHome)).toBe(false);
      expect(existsSync(healthHome)).toBe(false);
    }

    expect(targetStepIndex).toBeGreaterThanOrEqual(0);
    const precedingStepScopes = jobSteps.slice(0, targetStepIndex).flatMap((candidate, index) => {
      const stepLabel = `preceding step ${index + 1} (${candidate.name ?? "unnamed"})`;
      return [
        [`${stepLabel} run`, candidate.run ?? ""],
        [`${stepLabel} env`, JSON.stringify(candidate.env ?? {})],
        [`${stepLabel} with`, JSON.stringify(candidate.with ?? {})],
      ] as const;
    });

    const inheritedCronScopes = [
      ["workflow env", JSON.stringify(workflow.env ?? {})],
      ["job env", JSON.stringify(job?.env ?? {})],
      ["current step env", JSON.stringify(step.env ?? {})],
      ["current step before harness", run.slice(0, sliceStart)],
      ...precedingStepScopes,
      [
        "current step GITHUB_ENV writes",
        run
          .split("\n")
          .filter((line) => line.includes("GITHUB_ENV"))
          .join("\n"),
      ],
    ] as const;
    for (const [scope, text] of inheritedCronScopes) {
      expect(text, scope).not.toContain(cronEnv);
    }
  });
});

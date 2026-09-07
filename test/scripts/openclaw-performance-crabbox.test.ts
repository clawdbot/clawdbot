import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { buildSync } from "esbuild";
import { Compile } from "typebox/schema";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/openclaw-performance-crabbox.sh");
const CONFIG = ".github/crabbox/openclaw-performance-untrusted.yaml";
const SCHEMA = ".github/crabbox/openclaw-performance-evidence.schema.json";
const WORKFLOW = ".github/workflows/openclaw-performance.yml";
const PROFILE_FILTER = '.aws.instanceProfile == ""';
const INSPECT_FILTER =
  '.id == $id and .provider == "aws" and .network == "public" and .tailscale == null and .providerMetadata.instanceProfileAttached == false';
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function jqAccepts(filter: string, value: unknown): boolean {
  return (
    spawnSync("jq", ["-e", "--arg", "id", "cbx_0123456789ab", filter], {
      encoding: "utf8",
      input: JSON.stringify(value),
    }).status === 0
  );
}

function fixture() {
  const root = tempDirs.make("openclaw-performance-crabbox-");
  const artifact = ".artifacts/kova/reports/mock-provider/report.json";
  const artifactPath = join(root, artifact);
  const payload = join(root, "payload.tar.gz");
  const evidence = join(root, "remote-evidence.json");
  const timing = join(root, "timing.json");
  const output = join(root, ".artifacts/performance-crabbox/evidence/mock-provider.json");
  const contents = Buffer.from('{"status":"ok"}\n');
  mkdirSync(join(root, ".artifacts/kova/reports/mock-provider"), { recursive: true });
  writeFileSync(artifactPath, contents);
  execFileSync("tar", ["-czf", payload, "-C", root, artifact]);
  writeFileSync(
    evidence,
    JSON.stringify({
      schemaVersion: 1,
      lane: "mock-provider",
      testedRef: "refs/pull/1/head",
      openclawSha: "a".repeat(40),
      kovaSha: "b".repeat(40),
      workflow: { sha: "c".repeat(40), runId: "123", runAttempt: "1" },
      crabbox: {
        commit: "8ba71f913bbe57285ae29af45ef0d8ec6712477d",
        version: "0.46.0+8ba71f913bbe",
      },
      command: {
        name: "mock-provider",
        argv: [
          "profile=diagnostic",
          "repeat=1",
          "contract=canonical",
          "include=scenario:fresh-install",
          "failOnRegression=false",
        ],
        exitCode: 0,
        startedAt: "2026-08-21T00:00:00Z",
        finishedAt: "2026-08-21T00:01:00Z",
      },
      isolation: {
        sutUser: "openclaw-sut",
        trustedHarnessRootOwned: true,
        noSudo: true,
        imdsBlocked: true,
        environmentClean: true,
        cachesEmptyBefore: true,
        tailscaleRequested: false,
        tailscaleMetadataAbsent: true,
      },
      artifacts: [{ path: artifact, size: contents.length, sha256: sha256(contents) }],
      lease: { provider: "aws", market: "on-demand", cleanupPolicy: "always" },
    }),
  );
  writeFileSync(
    timing,
    JSON.stringify({
      provider: "aws",
      leaseId: "cbx_0123456789ab",
      runId: "run_0123456789ab",
      exitCode: 0,
    }),
  );
  return { artifact, evidence, output, payload, root, timing };
}

function verify(
  files: ReturnType<typeof fixture>,
  overrides: { evidence?: string; timing?: string } = {},
) {
  return spawnSync(
    "bash",
    [
      SCRIPT,
      "verify",
      "mock-provider",
      overrides.timing ?? files.timing,
      "cbx_0123456789ab",
      overrides.evidence ?? files.evidence,
      files.payload,
      files.output,
    ],
    { cwd: files.root, encoding: "utf8" },
  );
}

describe("OpenClaw performance Crabbox boundary", () => {
  it("retains bounded metadata and separate command/cleanup failures without raw paths", () => {
    const root = tempDirs.make("openclaw-performance-diagnostics-");
    const log = join(root, "run.log");
    const metadata = [
      `performance-export phase=producer uid=0 gid=0 workspace=${"a".repeat(64)}`,
      "performance-export path=.artifacts uid=0 gid=0 mode=700 size=4096 readable=false searchable=false",
    ];
    const kova = {
      commandExit: 17,
      evidenceExit: 0,
      bundleExit: 0,
      summaryExit: 0,
      records: [
        {
          scenario: "probe",
          state: "fresh",
          status: "BLOCKED",
          reason: "missing /home/fixture-user/private.json from 192.0.2.12",
        },
      ],
    };
    writeFileSync(
      log,
      [
        "x".repeat(300000),
        ...metadata,
        `performance-kova ${JSON.stringify(kova)}`,
        "performance-export path=/private/fixture/credential unavailable readable=false searchable=false",
        "unstructured private fixture output",
      ].join("\n"),
    );
    const workflow = parse(readFileSync(WORKFLOW, "utf8"));
    const run = workflow.jobs.external_performance.steps.find(
      (step: { name?: string }) => step.name === "Attest and run candidate in disposable Crabbox",
    ).run as string;
    const start = run.indexOf("write_diagnostics() {");
    const end = run.indexOf("confirm_cleanup() {", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const result = spawnSync(
      "bash",
      ["-euo", "pipefail", "-c", `${run.slice(start, end)}\nwrite_diagnostics`],
      {
        cwd: root,
        env: {
          ...process.env,
          timing_log: log,
          lane: "source",
          lease_id: "cbx_0123456789ab",
          command_status: "7",
          cleanup_confirmed: "false",
        },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(
      JSON.parse(
        readFileSync(join(root, ".artifacts/performance-crabbox/diagnostics/source.json"), "utf8"),
      ),
    ).toEqual({
      provider: "aws",
      leaseId: "cbx_0123456789ab",
      lane: "source",
      exitCode: 7,
      explicitStopConfirmed: false,
      metadata,
      kova: [
        {
          ...kova,
          records: [{ ...kova.records[0], reason: "missing <path> from <address>" }],
        },
      ],
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "prepares private collector-owned export ancestors before sudo",
    () => {
      const root = tempDirs.make("openclaw-performance-export-owner-");
      const script = join(root, ".crabbox/scripts/harness.sh");
      const bin = join(root, "bin");
      mkdirSync(join(root, ".crabbox/scripts"), { recursive: true });
      mkdirSync(bin);
      copyFileSync(SCRIPT, script);
      writeFileSync(join(bin, "sudo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const result = spawnSync(
        "bash",
        [
          script,
          "remote",
          "source",
          "a".repeat(40),
          "b".repeat(40),
          "c".repeat(40),
          "fixture",
          "diagnostic",
          "1",
          "canonical",
          "-",
          "-",
          "false",
          "1",
          "1",
          "fixture-client",
          "mock-model",
          "false",
        ],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      for (const path of [
        ".artifacts",
        ".artifacts/performance-crabbox",
        ".artifacts/performance-crabbox/source",
      ]) {
        const metadata = statSync(join(root, path));
        expect(metadata.uid).toBe(process.getuid?.());
        expect(metadata.mode & 0o777).toBe(0o700);
      }
    },
  );

  it.each([
    { capability: "all", expected: 0 },
    { capability: "no-sqlite", expected: 0 },
    { capability: "no-default", expected: 1 },
    { capability: "no-source", expected: 0 },
  ])(
    "preserves source probe coverage and capability skips: $capability",
    ({ capability, expected }) => {
      const root = tempDirs.make("openclaw-performance-source-parity-");
      const openclaw = join(root, "openclaw");
      const calls = join(root, "calls");
      mkdirSync(join(openclaw, "scripts"), { recursive: true });
      mkdirSync(join(openclaw, "src/config"), { recursive: true });
      mkdirSync(join(openclaw, ".artifacts/sqlite-perf"), { recursive: true });
      writeFileSync(join(openclaw, "src/config/zod-schema.core.ts"), "");
      writeFileSync(join(openclaw, "scripts/build-all.mts"), "");
      writeFileSync(join(openclaw, ".artifacts/sqlite-perf/smoke.json"), "{}");
      const script = readFileSync(SCRIPT, "utf8");
      const definitions = script.slice(0, script.lastIndexOf('\ncase "${1:-}" in'));
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${definitions}
npm() { :; }
pnpm() { printf 'pnpm %s\\n' "$*" >> "$CALLS"; }
git() { printf '%040d\\n' 0; }
curl() { return 0; }
node() {
  printf 'node %s\\n' "$*" >> "$CALLS"
  case "$*" in
    *extensionProbe*) [[ "$CAPABILITY" != no-source ]] ;;
    *test:sqlite:perf:smoke*) [[ "$CAPABILITY" != no-sqlite ]] ;;
    *build-all*--help*) printf '  sourcePerformance\\n' ;;
    *bench-gateway-startup*--help*)
      [[ "$CAPABILITY" == no-default ]] || printf '  default (baseline)\\n'
      printf '  skipChannels (channels)\\n' ;;
    *net.createServer*) echo 49152 ;;
    *randomBytes*) printf '%064d\\n' 0 ;;
  esac
}
run_sut source "$ROOT" diagnostic 2 canonical - - false "$ROOT/helpers" mock-model false
`,
        ],
        {
          env: { ...process.env, HOME: root, ROOT: root, CALLS: calls, CAPABILITY: capability },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(expected);
      const invocations = readFileSync(calls, "utf8");
      if (capability === "no-source") {
        expect(
          readFileSync(
            join(openclaw, ".artifacts/openclaw-performance/source/mock-provider/index.md"),
            "utf8",
          ),
        ).toContain("Source probes skipped");
        expect(invocations).not.toContain("pnpm test:gateway:cpu-scenarios");
        return;
      }
      if (capability === "no-default") {
        expect(result.stderr).toContain("required default case");
        expect(invocations).not.toContain("pnpm test:gateway:cpu-scenarios");
        return;
      }
      expect(invocations).toContain("--startup-case default --startup-case skipChannels");
      expect(invocations).toContain("pnpm test:extensions:memory");
      expect(invocations.match(/pnpm openclaw qa suite/g)).toHaveLength(2);
      expect(invocations).toContain("--scenario channel-chat-baseline");
      expect(invocations).toContain("--case gatewayHealthJsonWarmState");
      expect(invocations).toContain("--case gatewayHealthJsonFreshState");
      expect(invocations).toContain("--case configGetGatewayPort");
      expect(invocations.includes("pnpm test:sqlite:perf:smoke")).toBe(capability !== "no-sqlite");
      expect(invocations).toContain("openclaw-performance-source-summary.mjs");
    },
  );

  it.each([
    {
      name: "advisory BLOCKED",
      gated: false,
      sutExit: 17,
      records: true,
      planFilter: "scenario:probe",
      expected: 0,
    },
    {
      name: "unadaptable gated BLOCKED",
      gated: true,
      sutExit: 17,
      records: true,
      planFilter: "scenario:probe",
      expected: 17,
    },
    {
      name: "missing requested records",
      gated: false,
      sutExit: 0,
      records: false,
      planFilter: "scenario:probe",
      expected: 1,
    },
    {
      name: "wrong plan filters",
      gated: false,
      sutExit: 0,
      records: true,
      planFilter: "scenario:wrong",
      expected: 1,
    },
  ])(
    "enforces native Kova evidence and gate semantics: $name",
    ({ gated, sutExit, records, planFilter, expected }) => {
      const root = tempDirs.make("openclaw-performance-kova-contract-");
      const helpers = join(root, "helpers");
      const openclaw = join(root, "openclaw");
      mkdirSync(openclaw);
      buildSync({
        entryPoints: [
          "scripts/lib/kova-report-selector.mjs",
          "scripts/lib/kova-workflow-evidence.mts",
          "scripts/lib/kova-report-gate.mts",
          "scripts/kova-ci-summary.mts",
        ],
        bundle: true,
        platform: "node",
        format: "esm",
        outbase: "scripts",
        outdir: helpers,
        outExtension: { ".js": ".mjs" },
      });
      const common = { profile: { id: "diagnostic" }, target: `local-build:${openclaw}` };
      writeFileSync(
        join(root, "plan.fixture"),
        JSON.stringify({
          ...common,
          schemaVersion: "kova.matrix.plan.v1",
          controls: { include: [planFilter], repeat: 1 },
          entries: [{ scenario: { id: "probe" }, state: { id: "fresh" }, status: "SELECTED" }],
        }),
      );
      writeFileSync(
        join(root, "report.fixture"),
        JSON.stringify({
          ...common,
          schemaVersion: "kova.report.v1",
          mode: "execution",
          controls: { include: ["scenario:probe"], repeat: 1 },
          auth: { requestedMode: "mock" },
          summary: { statuses: { BLOCKED: 1 } },
          records: records
            ? [
                {
                  scenario: "probe",
                  state: { id: "fresh" },
                  status: "BLOCKED",
                  repeat: { total: 1, index: 1 },
                  auth: { mode: "mock" },
                  failureReason: "fixture blocked prerequisite",
                },
              ]
            : [],
        }),
      );
      const script = readFileSync(SCRIPT, "utf8");
      const definitions = script.slice(0, script.lastIndexOf('\ncase "${1:-}" in'));
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${definitions}
npm() { :; }
pnpm() { :; }
node() { printf '%s\\n' "$*" >> "$ROOT/helper-calls"; command node "$@"; }
kova() {
  case "$1 $2" in
    "matrix plan") cat "$ROOT/plan.fixture" ;;
    "matrix run")
      cp "$ROOT/report.fixture" "$ROOT/openclaw/.artifacts/kova/reports/mock-provider/report.json"
      return "$SUT_EXIT" ;;
    "report bundle") printf '{"files":[]}\\n' ;;
  esac
}
run_sut mock-provider "$ROOT" diagnostic 1 canonical scenario:probe - "$GATED" "$ROOT/helpers" mock-model true
`,
        ],
        {
          env: {
            ...process.env,
            ROOT: root,
            HOME: root,
            SUT_EXIT: String(sutExit),
            GATED: String(gated),
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(expected);
      if (planFilter !== "scenario:probe") {
        expect(result.stderr).toContain("did not preserve the requested include filters");
      } else {
        const calls = readFileSync(join(root, "helper-calls"), "utf8");
        expect(calls).toContain("kova-workflow-evidence.mjs");
        expect(calls.includes("kova-report-gate.mjs")).toBe(gated && records && sutExit !== 0);
        if (gated) {
          expect(calls).toContain("--require-instrumented-performance-contract");
        }
        if (records) {
          expect(result.stdout).toContain("performance-kova ");
          expect(result.stdout).toContain("fixture blocked prerequisite");
          expect(
            readFileSync(join(openclaw, ".artifacts/kova/summaries/mock-provider.md"), "utf8"),
          ).toContain("fixture blocked prerequisite");
        } else {
          expect(result.stderr).toContain("coverage");
        }
      }
    },
  );

  it("rejects ambiguous external Kova reports with the native selector", () => {
    const root = tempDirs.make("openclaw-performance-kova-selection-");
    writeFileSync(join(root, "first.json"), "{}");
    writeFileSync(join(root, "second.json"), "{}");
    const script = readFileSync(SCRIPT, "utf8");
    const selection = script.match(/^\s*report="\$\([^\n]+\)"$/m)?.[0];
    expect(selection).toBeDefined();
    const result = spawnSync("bash", ["-e", "-c", selection!], {
      env: { ...process.env, report_dir: root, helpers: resolve("scripts") },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected exactly one full Kova JSON report");
  });

  it.each([
    {
      name: "mixed scalars and arrays",
      records: [null, true, 1, "message", [], {}],
      status: 0,
      lane: "source",
      expected: 0,
      timing: true,
    },
    {
      name: "wrong lease",
      records: [{ provider: "aws", leaseId: "cbx_abcdef123456", runId: "run_other", exitCode: 0 }],
      status: 0,
      lane: "source",
      expected: 1,
      timing: false,
    },
    {
      name: "missing timing",
      records: [null, "message"],
      status: 0,
      lane: "source",
      expected: 1,
      timing: false,
    },
    {
      name: "failed command",
      records: [false, []],
      status: 7,
      lane: "source",
      expected: 7,
      timing: true,
    },
    {
      name: "cleanup probe",
      records: [null, "message"],
      status: 42,
      lane: "cleanup-probe",
      expected: 0,
      timing: true,
    },
    {
      name: "wrong cleanup status",
      records: [],
      status: 7,
      lane: "cleanup-probe",
      expected: 1,
      timing: true,
    },
  ])(
    "selects bound timing from $name without changing command status",
    ({ records, status, lane, expected, timing }) => {
      const workflow = parse(readFileSync(WORKFLOW, "utf8"));
      const run = workflow.jobs.external_performance.steps.find(
        (step: { name: string }) => step.name === "Attest and run candidate in disposable Crabbox",
      ).run as string;
      const start = run.lastIndexOf("\ntrap - EXIT") + "\ntrap - EXIT".length;
      const end = run.indexOf("\nscripts/openclaw-performance-crabbox.sh verify");
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const root = tempDirs.make("performance-timing-");
      const timingLog = join(root, "timing.log");
      const lease = "cbx_0123456789ab";
      const lines: unknown[] = [...records];
      if (timing) {
        lines.push({ provider: "aws", leaseId: lease, runId: "run_expected", exitCode: status });
      }
      writeFileSync(
        timingLog,
        ["plain output", ...lines.map((line) => JSON.stringify(line))].join("\n"),
      );
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", run.slice(start, end)], {
        encoding: "utf8",
        env: {
          ...process.env,
          downloads: root,
          timing_log: timingLog,
          lease_id: lease,
          status: String(status),
          lane,
        },
      });
      expect(result.status, result.stderr).toBe(expected);
      expect(result.stderr).not.toContain("Cannot index");
      if (timing) {
        expect(JSON.parse(readFileSync(join(root, "timing.json"), "utf8"))).toMatchObject({
          leaseId: lease,
          exitCode: status,
        });
      }
    },
  );

  it("uses dedicated AWS on-demand leases with no caches or forwarded environment", () => {
    const config = parse(readFileSync(CONFIG, "utf8")) as {
      provider?: string;
      serverType?: string;
      capacity?: { market?: string };
      cache?: Record<string, boolean>;
      env?: { allow?: string[] };
      sync?: { gitSeed?: boolean; fingerprint?: boolean; include?: string[] };
    };

    expect(config.provider).toBe("aws");
    expect(config.serverType).toBe("c7a.24xlarge");
    expect(config.capacity?.market).toBe("on-demand");
    expect(config.cache).toMatchObject({
      pnpm: false,
      npm: false,
      docker: false,
      git: false,
      purgeOnRelease: true,
    });
    expect(config.env?.allow).toEqual(["OPENCLAW_PERFORMANCE_NO_ENV"]);
    expect(config.sync).toMatchObject({ gitSeed: false, fingerprint: false });
    expect(config.sync?.include).toEqual([
      SCHEMA,
      "scripts/openclaw-performance-crabbox.sh",
      ".artifacts/performance-control/helpers",
    ]);
  });

  it("keeps candidate bytes off Actions runners and stops every lease", () => {
    const workflow = readFileSync(WORKFLOW, "utf8");
    const script = readFileSync(SCRIPT, "utf8");
    const parsed = parse(workflow) as {
      jobs: Record<
        string,
        {
          if?: string;
          steps?: Array<{
            name?: string;
            env?: Record<string, string>;
            run?: string;
            uses?: string;
            with?: Record<string, string>;
          }>;
        }
      >;
    };
    const kova = expectDefined(parsed.jobs.kova, "kova job");
    const sourcePerformance = expectDefined(
      parsed.jobs.source_performance,
      "source performance job",
    );
    const external = expectDefined(parsed.jobs.external_performance, "external performance job");
    const checkout = external.steps?.find(
      (step) => step.name === "Checkout trusted performance harness",
    );
    const checkouts = external.steps?.filter((step) => step.uses?.startsWith("actions/checkout@"));
    const secretSteps = external.steps?.filter((step) =>
      JSON.stringify(step.env ?? {}).includes("CRABBOX_COORDINATOR"),
    );
    const run = expectDefined(
      external.steps?.find((step) => step.name === "Attest and run candidate in disposable Crabbox")
        ?.run,
      "external candidate run step",
    );

    expect(workflow).toContain("CRABBOX_COMMIT: 8ba71f913bbe57285ae29af45ef0d8ec6712477d");
    expect(workflow).toContain("external_required:");
    expect(workflow).toContain(
      "--provider aws --target linux --arch amd64 --class beast --type c7a.24xlarge",
    );
    expect(workflow).toContain("--network public --tailscale=false");
    expect(workflow).toContain("--tailscale-exit-node=");
    expect(workflow).toContain("--tailscale-exit-node-allow-lan-access=false");
    expect(workflow).not.toContain("--stop-after always");
    expect(run).toContain("--stop-after never --timing-json --no-hydrate --allow-env CI");
    expect(run).toContain("tailscale_requested=false tailscale_metadata=none");
    expect(run).toContain("unset CRABBOX_AWS_INSTANCE_PROFILE");
    expect(workflow).toContain("CRABBOX_ENV_ALLOW=CI");
    expect(run).toContain(PROFILE_FILTER);
    expect(run).toContain(INSPECT_FILTER);
    expect(run.indexOf("config show --json")).toBeLessThan(run.indexOf('"$crabbox" warmup'));
    expect(run.indexOf('"$crabbox" warmup')).toBeLessThan(run.indexOf('"$crabbox" inspect'));
    expect(run.indexOf('"$crabbox" inspect')).toBeLessThan(
      run.indexOf('run --provider aws --id "$lease_id"'),
    );
    expect(run.indexOf("args=(")).toBeLessThan(run.indexOf('"$crabbox" "${args[@]}"'));
    expect(run.indexOf('"$crabbox" "${args[@]}"')).toBeLessThan(
      run.lastIndexOf("\nconfirm_cleanup"),
    );
    expect(run.lastIndexOf("\nconfirm_cleanup")).toBeLessThan(run.lastIndexOf("\ntrap - EXIT"));
    expect(run.lastIndexOf("\ntrap - EXIT")).toBeLessThan(
      run.indexOf("scripts/openclaw-performance-crabbox.sh verify"),
    );
    expect(run).not.toContain('stop --provider aws "$lease_id" >/dev/null 2>&1 || true');
    expect(run).toContain('[[ "$cleanup_attempted" == true ]] || confirm_cleanup || status=1');
    expect(run).toContain('[[ "$cleanup_confirmed" == true ]] || status=1');
    expect(run).toContain('[[ "$status" == 42 ]]');
    expect(run).toContain('2>&1 | tee "$timing_log"');
    expect(run).toContain("status=${PIPESTATUS[0]}");
    expect(run).not.toContain('select(has("leaseStopped"))');
    expect(run).toContain("--require-artifact-schema");
    expect(workflow).toContain(
      "CRABBOX_COORDINATOR: ${{ secrets.CRABBOX_COORDINATOR || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR }}",
    );
    expect(workflow).toContain(
      "CRABBOX_COORDINATOR_TOKEN: ${{ secrets.CRABBOX_COORDINATOR_TOKEN || secrets.OPENCLAW_QA_MANTIS_CRABBOX_COORDINATOR_TOKEN }}",
    );
    expect(workflow).toContain(
      "if: ${{ success() && steps.lane.outputs.run == 'true' && matrix.lane != 'cleanup-probe' }}",
    );
    expect(workflow).not.toContain("Checkout target metadata");
    expect(workflow).not.toContain("TARGET_CHECKOUT_DIR");
    expect(kova.if).toContain("needs.resolve_target.outputs.external_required != 'true'");
    expect(sourcePerformance.if).toContain(
      "needs.resolve_target.outputs.external_required != 'true'",
    );
    expect(external.if).toContain("needs.resolve_target.outputs.external_required == 'true'");
    expect(checkout?.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(checkouts?.map((step) => step.with?.ref)).toEqual(["${{ github.workflow_sha }}"]);
    expect(secretSteps?.map((step) => step.name)).toEqual([
      "Attest and run candidate in disposable Crabbox",
    ]);
    expect(script).toContain('runuser -u "$SUT_USER" -- env -i');
    expect(script).toContain(
      'control_workspace="$(dirname "$(dirname "$(dirname "$(realpath "$0")")")")"',
    );
    expect(script).toContain('"$root_script" "$0" "$root_script" "$control_workspace" remote "$@"');
    expect(script).toContain('local control_workspace="$PWD"');
    expect(script).toContain(
      'local output="$control_workspace/.artifacts/performance-crabbox/$lane"',
    );
    expect(script).toContain('kova-report-selector.mjs" --report-dir "$report_dir"');
    expect(script).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(script).toContain('as_sut git -C "$destination" rev-parse HEAD');
    expect(script).toContain('as_sut git -C "$root/openclaw" rev-parse HEAD');
    expect(script).toContain('as_sut git -C "$root/kova" rev-parse HEAD');
    expect(script).toContain("iptables -I OUTPUT -m owner --uid-owner");
    expect(script).toContain('pkill -KILL -u "$uid"');
  });

  it("rejects resolved roles, Tailscale, and unattested instance-profile state", () => {
    expect(jqAccepts(PROFILE_FILTER, { aws: { instanceProfile: "" } })).toBe(true);
    expect(jqAccepts(PROFILE_FILTER, { aws: { instanceProfile: "unsafe-role" } })).toBe(false);

    const safe = {
      id: "cbx_0123456789ab",
      provider: "aws",
      network: "public",
      tailscale: null,
      providerMetadata: { instanceProfileAttached: false },
    };
    expect(jqAccepts(INSPECT_FILTER, safe)).toBe(true);
    expect(jqAccepts(INSPECT_FILTER, { ...safe, tailscale: { state: "ok" } })).toBe(false);
    expect(
      jqAccepts(INSPECT_FILTER, {
        ...safe,
        providerMetadata: { instanceProfileAttached: true },
      }),
    ).toBe(false);
    expect(jqAccepts(INSPECT_FILTER, { ...safe, providerMetadata: {} })).toBe(false);
  });

  it("derives artifact export from the Crabbox workspace, not the login cwd", () => {
    const root = tempDirs.make("openclaw-performance-workspace-");
    const uploaded = join(root, ".crabbox/scripts/harness.sh");
    mkdirSync(join(root, ".crabbox/scripts"), { recursive: true });
    writeFileSync(uploaded, "#!/bin/sh\n");

    const derived = execFileSync(
      "bash",
      ["-c", 'dirname "$(dirname "$(dirname "$(realpath "$1")")")"', "bash", uploaded],
      { encoding: "utf8" },
    ).trim();
    expect(derived).toBe(root);
  });

  it("accepts an already-released lease only when explicit stop confirms it", () => {
    const root = tempDirs.make("openclaw-performance-stop-");
    const crabbox = join(root, "crabbox");
    writeFileSync(
      crabbox,
      '#!/bin/sh\n[ "$1:$2:$3:$4:$5" = "stop:--provider:aws:--id:cbx_0123456789ab" ] || exit 64\n',
    );
    chmodSync(crabbox, 0o755);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync("bash", [SCRIPT, "confirm-stop", crabbox, "cbx_0123456789ab"]);
      expect(result.status).toBe(0);
    }
  });

  it("rejects coordinator cleanup that remains pending", () => {
    const root = tempDirs.make("openclaw-performance-stop-");
    const crabbox = join(root, "crabbox");
    writeFileSync(
      crabbox,
      '#!/bin/sh\n[ "$1:$2:$3:$4:$5" = "stop:--provider:aws:--id:cbx_0123456789ab" ] || exit 64\nexit 5\n',
    );
    chmodSync(crabbox, 0o755);

    const result = spawnSync("bash", [SCRIPT, "confirm-stop", crabbox, "cbx_0123456789ab"]);
    expect(result.status).toBe(5);
  });

  it("verifies tar paths, sizes, hashes, and lease cleanup before export", () => {
    const files = fixture();
    const result = verify(files);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(files.root, files.artifact), "utf8")).toBe('{"status":"ok"}\n');
    expect(JSON.parse(readFileSync(files.output, "utf8")).lease).toEqual({
      provider: "aws",
      market: "on-demand",
      cleanupPolicy: "always",
      id: "cbx_0123456789ab",
      stopped: true,
      stopError: "",
    });
    expect(JSON.parse(readFileSync(files.output, "utf8")).isolation).toMatchObject({
      tailscaleRequested: false,
      tailscaleMetadataAbsent: true,
    });
  });

  it("rejects artifact hash drift", () => {
    const files = fixture();
    const evidence = JSON.parse(readFileSync(files.evidence, "utf8")) as {
      artifacts: Array<{ sha256: string }>;
    };
    expectDefined(evidence.artifacts[0], "artifact evidence").sha256 = "0".repeat(64);
    writeFileSync(files.evidence, JSON.stringify(evidence));

    const result = verify(files);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("payload hash mismatch");
  });

  it("rejects timing for a different lease", () => {
    const files = fixture();
    writeFileSync(
      files.timing,
      JSON.stringify({
        leaseId: "cbx_abcdef123456",
        leaseStopped: false,
        leaseStopError: "release failed",
      }),
    );

    const result = verify(files);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Crabbox timing did not bind the expected lease");
  });

  it("keeps the evidence schema bound to immutable revisions and cleanup", () => {
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(schema.required).toEqual(
      expect.arrayContaining(["openclawSha", "kovaSha", "workflow", "crabbox", "command", "lease"]),
    );
    expect(schema.properties).toHaveProperty("artifacts");
    expect(schema.properties).toHaveProperty("isolation");
  });

  it("rejects malformed remote evidence against the checked-in schema", () => {
    const schema = JSON.parse(readFileSync(SCHEMA, "utf8")) as object;
    const evidence = JSON.parse(readFileSync(fixture().evidence, "utf8")) as {
      isolation: Record<string, unknown>;
    };
    const validator = Compile(schema);
    expect(validator.Check(evidence)).toBe(true);
    delete evidence.isolation.tailscaleMetadataAbsent;
    expect(validator.Check(evidence)).toBe(false);
  });
});

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readMantisLifecycleEvidence,
  readReadyMantisLifecycleGeneration,
  runMantisSutLifecycleAction,
} from "../../scripts/e2e/telegram-mantis-sut.ts";

const CONTAINER_A = "a".repeat(64);
const CONTAINER_B = "b".repeat(64);
const MOCK_CONTAINER = "c".repeat(64);
const PROXY_CONTAINER = "d".repeat(64);
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-08-22T12:00:00.000Z";
const SUT_WRAPPER = "scripts/mantis/mantis-sut-container.sh";
const tempRoots: string[] = [];

function lifecycleEvidence(): Array<Record<string, unknown>> {
  return [
    { event: "gateway_starting", generation: 1 },
    {
      event: "sidecars_bound",
      generation: 1,
      mockContainerId: MOCK_CONTAINER,
      proxyContainerId: PROXY_CONTAINER,
    },
    { containerId: CONTAINER_A, event: "gateway_started", generation: 1 },
    { containerId: CONTAINER_A, event: "gateway_ready", generation: 1 },
    {
      containerId: CONTAINER_A,
      event: "lifecycle_requested",
      generation: 1,
      mode: "crash",
      requestId: REQUEST_ID,
    },
    {
      containerId: CONTAINER_A,
      event: "gateway_exited",
      exitCode: 137,
      expected: true,
      generation: 1,
      mode: "crash",
      requestId: REQUEST_ID,
      termination: "forced",
    },
    { event: "gateway_starting", generation: 2, requestId: REQUEST_ID },
    {
      containerId: CONTAINER_B,
      event: "gateway_started",
      generation: 2,
      requestId: REQUEST_ID,
    },
    {
      containerId: CONTAINER_B,
      event: "gateway_ready",
      generation: 2,
      requestId: REQUEST_ID,
    },
  ].map((event, index) =>
    Object.assign(event, {
      at: AT,
      schemaVersion: 1,
      sequence: index + 1,
    }),
  );
}

function writeEvidence(events = lifecycleEvidence()): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-lifecycle-test-"));
  tempRoots.push(root);
  const file = path.join(root, "lifecycle-events.ndjson");
  fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return file;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("Mantis SUT lifecycle action", () => {
  it.skipIf(process.platform !== "linux")(
    "returns from continuity validation so the caller can record a terminal dependency fact",
    () => {
      const wrapper = fs.readFileSync(SUT_WRAPPER, "utf8");
      const validatorStart = wrapper.indexOf("require_container_continuity() {");
      const validatorEnd = wrapper.indexOf("\n# The probe must reach", validatorStart);
      expect(validatorStart).toBeGreaterThanOrEqual(0);
      expect(validatorEnd).toBeGreaterThan(validatorStart);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-validator-test-"));
      tempRoots.push(root);
      const fakeDocker = path.join(root, "docker");
      fs.writeFileSync(fakeDocker, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const harness = path.join(root, "validator.sh");
      fs.writeFileSync(
        harness,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          `readonly docker_bin=${JSON.stringify(fakeDocker)}`,
          "readonly gateway_probe_script='process.exit(1)'",
          wrapper.slice(validatorStart, validatorEnd),
          'if require_container_continuity gateway "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" gateway net; then',
          "  exit 91",
          "fi",
          'printf "validator-returned\\n"',
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("/bin/bash", [harness], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("validator-returned\n");
      expect(result.stderr).toContain("gateway container identity changed");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "continues exact stop cleanup after lifecycle evidence cancellation fails",
    () => {
      const wrapper = fs.readFileSync(SUT_WRAPPER, "utf8");
      const stopStart = wrapper.indexOf("  __stop)\n");
      const stopEnd = wrapper.indexOf("\n    ;;\n  destroy)", stopStart);
      expect(stopStart).toBeGreaterThanOrEqual(0);
      expect(stopEnd).toBeGreaterThan(stopStart);
      const stopBody = wrapper.slice(stopStart + "  __stop)\n".length, stopEnd);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mantis-stop-failure-test-"));
      tempRoots.push(root);
      const safeRuntime = path.join(root, "safe-runtime");
      fs.mkdirSync(safeRuntime);
      fs.writeFileSync(path.join(safeRuntime, "lifecycle-control.lock"), "");
      fs.writeFileSync(path.join(safeRuntime, "lifecycle-state.json"), "{}\n");
      const runtimeSource = path.join(
        os.tmpdir(),
        `openclaw-tg-crabbox-sut-${process.pid}${Date.now()}`,
      );
      fs.symlinkSync(safeRuntime, runtimeSource, "dir");
      tempRoots.push(runtimeSource);
      const calls = path.join(root, "calls.log");
      const harness = path.join(root, "stop.sh");
      fs.writeFileSync(
        harness,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          "readonly flock_bin=/bin/true",
          `readonly calls=${JSON.stringify(calls)}`,
          `readonly safe_runtime_fixture=${JSON.stringify(safeRuntime)}`,
          'die() { echo "mantis SUT container: $*" >&2; exit 64; }',
          "require_cleanup_timeout_parent() { :; }",
          "require_container_name() { :; }",
          "cancel_runtime_claim() { :; }",
          'locked_runtime_root() { printf "%s\\n" "$safe_runtime_fixture"; }',
          'open_lifecycle_lock() { printf -v "$2" "%s" 9; }',
          "run_lifecycle_controller() { return 23; }",
          'terminate_runtime_claim() { echo terminate >>"$calls"; }',
          'remove_container_or_fail() { echo "container:$1" >>"$calls"; }',
          'cleanup_network() { echo "network:$1" >>"$calls"; }',
          'wait_for_runtime_claim_exit() { echo wait >>"$calls"; }',
          `set -- openclaw-telegram-sut-dead ${JSON.stringify(runtimeSource)}`,
          stopBody,
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("/bin/bash", [harness], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("stop completed with lifecycle evidence or cleanup errors");
      expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        "terminate",
        "container:openclaw-telegram-sut-dead",
        "container:openclaw-telegram-sut-dead-mock-openai",
        "container:openclaw-telegram-sut-dead-telegram-proxy",
        "network:openclaw-telegram-sut-dead-net",
        "network:openclaw-telegram-sut-dead-egress",
        "wait",
      ]);
    },
  );

  it("releases lifecycle serialization before bounded external Docker actions", () => {
    const wrapper = fs.readFileSync(SUT_WRAPPER, "utf8");
    const lifecycle = wrapper.slice(wrapper.indexOf("  __lifecycle)"), wrapper.indexOf("  stop)"));
    const request = lifecycle.indexOf("run_lifecycle_controller request");
    const unlock = lifecycle.indexOf("exec {lifecycle_lock_fd}>&-", request);
    const dockerStop = lifecycle.indexOf('"$docker_bin" stop --time 10 "$gateway_container_id"');
    const dockerKill = lifecycle.indexOf(
      '"$docker_bin" kill --signal KILL "$gateway_container_id"',
    );

    expect(request).toBeGreaterThanOrEqual(0);
    expect(unlock).toBeGreaterThan(request);
    expect(unlock).toBeLessThan(dockerStop);
    expect(unlock).toBeLessThan(dockerKill);
    expect(lifecycle.slice(dockerStop)).not.toContain("exec {lifecycle_lock_fd}>&-");
    expect(lifecycle).not.toContain('"$docker_bin" stop --time 10 "$container_name"');
    expect(lifecycle).not.toContain('"$docker_bin" kill --signal KILL "$container_name"');
  });

  it("carries the exact requested readiness timeout into the successor wait", () => {
    const wrapper = fs.readFileSync(SUT_WRAPPER, "utf8");
    const supervisor = wrapper.slice(
      wrapper.indexOf("    generation=1"),
      wrapper.indexOf("  lifecycle)"),
    );
    const beforeExit = supervisor.indexOf(
      'state_before_exit="$(run_lifecycle_controller status "$safe_runtime")"',
    );
    const exited = supervisor.indexOf('successor_state="$(run_lifecycle_controller exited');
    const extract = supervisor.indexOf(
      "readiness_timeout=\"$(jq -er '.activeRequest.readinessTimeoutSeconds'",
    );
    const nextGeneration = supervisor.indexOf(
      'generation="$(jq -er \'.generation\' <<<"$successor_state")"',
    );

    expect(beforeExit).toBeGreaterThanOrEqual(0);
    expect(exited).toBeGreaterThan(beforeExit);
    expect(extract).toBeGreaterThan(exited);
    expect(nextGeneration).toBeGreaterThan(extract);
    expect(supervisor).toContain('require_readiness_timeout "$readiness_timeout"');
    expect(supervisor).toContain('"$gateway_log_offset" "$readiness_timeout"');
  });

  it("allows bounded successor discovery before the requested readiness budget", () => {
    const wrapper = fs.readFileSync(SUT_WRAPPER, "utf8");
    const lifecycle = wrapper.slice(wrapper.indexOf("  __lifecycle)"), wrapper.indexOf("  stop)"));

    expect(lifecycle).toContain("lifecycle_deadline=$((SECONDS + 10 + readiness_timeout))");
    expect(wrapper).toContain("local deadline=$((SECONDS + 10))");
    expect(wrapper).toContain("local deadline_seconds=$((10#$5 + 25))");
  });

  it("publishes the authoritative gateway port before lifecycle state or Docker startup", () => {
    const wrapper = fs.readFileSync(SUT_WRAPPER, "utf8");
    const run = wrapper.slice(wrapper.indexOf("  run)"), wrapper.indexOf("  lifecycle)"));
    const denylist = run.indexOf("for name in gateway-port gateway.log");
    const publish = run.indexOf('write_root_port_file "$safe_runtime" "$gateway_port"');
    const initialize = run.indexOf('run_lifecycle_controller initialize "$safe_runtime"');
    const docker = run.indexOf('"$docker_bin" run --detach');

    expect(denylist).toBeGreaterThanOrEqual(0);
    expect(publish).toBeGreaterThan(denylist);
    expect(publish).toBeLessThan(initialize);
    expect(publish).toBeLessThan(docker);
    expect(run).toContain('gateway_port="$5"');
    expect(run).toContain('export OPENCLAW_GATEWAY_PORT="$gateway_port"');
    expect(wrapper).toContain('gateway_port="$(read_port_file "$safe_runtime")"');
  });

  it("revalidates the successor and live sidecars at the success boundary", () => {
    const wrapper = fs.readFileSync(SUT_WRAPPER, "utf8");
    const lifecycle = wrapper.slice(wrapper.indexOf("  __lifecycle)"), wrapper.indexOf("  stop)"));
    const readyBranch = lifecycle.slice(lifecycle.indexOf('if [[ "$lifecycle_phase" == "ready"'));

    expect(readyBranch).toContain("require_gateway_action_boundary_ready");
    expect(readyBranch).toContain('require_container_continuity "${container_name}-mock-openai"');
    expect(readyBranch).toContain(
      'require_container_continuity "${container_name}-telegram-proxy"',
    );
    expect(readyBranch).toContain('lifecycle_state="$(run_lifecycle_controller status');
    expect(readyBranch.indexOf("require_gateway_action_boundary_ready")).toBeLessThan(
      readyBranch.indexOf("printf '%s\\n'"),
    );
    expect(readyBranch.indexOf("require_exact_runtime_claim_active")).toBeLessThan(
      readyBranch.indexOf("printf '%s\\n'"),
    );
    expect(wrapper).toContain(
      '"$docker_bin" exec --env OPENCLAW_MANTIS_GATEWAY_PORT="$gateway_port" \\\n    "$container_id"',
    );
    expect(wrapper).not.toContain(
      '"$docker_bin" exec --env OPENCLAW_MANTIS_GATEWAY_PORT="$gateway_port" \\\n          "$container_name"',
    );
  });

  it("keeps failed-state cancellation ahead of complete stop cleanup", () => {
    const wrapper = fs.readFileSync(SUT_WRAPPER, "utf8");
    const stop = wrapper.slice(wrapper.indexOf("  __stop)"), wrapper.indexOf("  destroy)"));
    const cancel = stop.indexOf('run_lifecycle_controller cancel "$safe_runtime"');
    const terminate = stop.indexOf("terminate_runtime_claim");
    const gateway = stop.indexOf('remove_container_or_fail "$1"');
    const mock = stop.indexOf('remove_container_or_fail "${1}-mock-openai"');
    const proxy = stop.indexOf('remove_container_or_fail "${1}-telegram-proxy"');
    const internalNetwork = stop.indexOf('cleanup_network "${1}-net"');
    const egressNetwork = stop.indexOf('cleanup_network "${1}-egress"');
    const wait = stop.indexOf("wait_for_runtime_claim_exit");

    expect(cancel).toBeGreaterThanOrEqual(0);
    for (const cleanup of [terminate, gateway, mock, proxy, internalNetwork, egressNetwork, wait]) {
      expect(cleanup).toBeGreaterThan(cancel);
    }
  });

  it("binds CLI arguments, successor state, and root evidence to one request", () => {
    const evidence = writeEvidence();
    const calls: Array<{ args: string[]; command: string }> = [];
    const result = runMantisSutLifecycleAction(
      {
        containerName: "openclaw-telegram-sut-11111111-1111-4111-8111-111111111111",
        expectedGeneration: 1,
        lifecycleEvidence: evidence,
        mode: "crash",
        readinessTimeoutSeconds: 60,
        runtimeRoot: "/tmp/openclaw-tg-crabbox-sut-abc123",
      },
      (command, args) => {
        calls.push({ args, command });
        return {
          status: 0,
          stdout: JSON.stringify({
            causedByRequestId: REQUEST_ID,
            containerId: CONTAINER_B,
            generation: 2,
            mockContainerId: MOCK_CONTAINER,
            phase: "ready",
            proxyContainerId: PROXY_CONTAINER,
            schemaVersion: 1,
            sequence: 9,
          }),
        };
      },
    );
    expect(calls).toEqual([
      {
        args: [
          "-n",
          "/usr/local/sbin/openclaw-mantis-sut-container",
          "lifecycle",
          "openclaw-telegram-sut-11111111-1111-4111-8111-111111111111",
          "/tmp/openclaw-tg-crabbox-sut-abc123",
          "1",
          "crash",
          "60",
        ],
        command: "sudo",
      },
    ]);
    expect(result).toMatchObject({ generation: 2, requestId: REQUEST_ID });
    expect(result.events.at(-1)).toMatchObject({
      containerId: CONTAINER_B,
      event: "gateway_ready",
      generation: 2,
      requestId: REQUEST_ID,
    });
  });

  it("rejects missing journal ordinals before accepting lifecycle proof", () => {
    const events = lifecycleEvidence();
    events.splice(4, 1);
    const evidence = writeEvidence(events);
    expect(() => readMantisLifecycleEvidence(evidence)).toThrow("missing or duplicate sequence");
  });

  it("recovers the current generation from root evidence after a lane process crash", () => {
    const evidence = writeEvidence();

    // A stale lane JSON would still describe generation 1 here. Generation identity
    // is deliberately recovered from the root-owned N+1 journal instead.
    expect(readReadyMantisLifecycleGeneration(evidence)).toBe(2);
  });

  it("retries the same ready generation after a Docker trigger failure", () => {
    const events = lifecycleEvidence().slice(0, 4);
    events.push(
      {
        at: AT,
        containerId: CONTAINER_A,
        event: "lifecycle_requested",
        generation: 1,
        mode: "graceful",
        requestId: REQUEST_ID,
        schemaVersion: 1,
        sequence: 5,
      },
      {
        at: AT,
        containerId: CONTAINER_A,
        event: "lifecycle_request_failed",
        generation: 1,
        mode: "graceful",
        requestId: REQUEST_ID,
        schemaVersion: 1,
        sequence: 6,
      },
    );

    expect(readReadyMantisLifecycleGeneration(writeEvidence(events))).toBe(1);
  });

  it("rejects a ready state that is not backed by the exact successor event", () => {
    const evidence = writeEvidence();
    expect(() =>
      runMantisSutLifecycleAction(
        {
          containerName: "openclaw-telegram-sut-11111111-1111-4111-8111-111111111111",
          expectedGeneration: 1,
          lifecycleEvidence: evidence,
          mode: "graceful",
          readinessTimeoutSeconds: 60,
          runtimeRoot: "/tmp/openclaw-tg-crabbox-sut-abc123",
        },
        () => ({
          status: 0,
          stdout: JSON.stringify({
            causedByRequestId: "22222222-2222-4222-8222-222222222222",
            containerId: CONTAINER_B,
            generation: 2,
            mockContainerId: MOCK_CONTAINER,
            phase: "ready",
            proxyContainerId: PROXY_CONTAINER,
            schemaVersion: 1,
            sequence: 9,
          }),
        }),
      ),
    ).toThrow("evidence does not match the ready successor");
  });

  it("surfaces bounded root-wrapper failures without reading stale evidence", () => {
    const evidence = writeEvidence();
    expect(() =>
      runMantisSutLifecycleAction(
        {
          containerName: "openclaw-telegram-sut-11111111-1111-4111-8111-111111111111",
          expectedGeneration: 1,
          lifecycleEvidence: evidence,
          mode: "crash",
          readinessTimeoutSeconds: 5,
          runtimeRoot: "/tmp/openclaw-tg-crabbox-sut-abc123",
        },
        () => ({ status: 64, stderr: "stale gateway lifecycle generation" }),
      ),
    ).toThrow(/failed with exit code 64.*stale gateway lifecycle generation/su);
  });
});

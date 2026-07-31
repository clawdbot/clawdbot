// Plugin Update Unchanged Docker tests cover plugin update unchanged docker script behavior.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";

const PLUGIN_UPDATE_DOCKER_SCRIPT = "scripts/e2e/plugin-update-unchanged-docker.sh";
const PLUGIN_UPDATE_SCENARIO_SCRIPT = "scripts/e2e/lib/plugin-update/unchanged-scenario.sh";
const CORRUPT_UPDATE_SCENARIO_SCRIPT = "scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh";
const PLUGIN_UPDATE_PROBE_SCRIPT = "scripts/e2e/lib/plugin-update/probe.mjs";
const PLUGIN_UPDATE_REGISTRY_SCRIPT = "scripts/e2e/lib/plugin-update/registry-server.mjs";
const CORRUPT_PLUGIN_ID = "demo-corrupt-plugin";

function runProbe(command: string, payload: unknown): void {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-probe-"));
  const payloadPath = path.join(root, "payload.json");
  try {
    writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
    execFileSync("node", [PLUGIN_UPDATE_PROBE_SCRIPT, command, payloadPath, CORRUPT_PLUGIN_ID], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runProbeStatus(
  command: string,
  payload: unknown,
): { status: number | null; stderr: string } {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-probe-"));
  const payloadPath = path.join(root, "payload.json");
  try {
    writeFileSync(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
    const result = spawnSync(
      "node",
      [PLUGIN_UPDATE_PROBE_SCRIPT, command, payloadPath, CORRUPT_PLUGIN_ID],
      {
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runProbeFileStatus(
  command: string,
  filePath: string,
): { status: number | null; stderr: string } {
  const result = spawnSync("node", [PLUGIN_UPDATE_PROBE_SCRIPT, command, filePath], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return { status: result.status, stderr: result.stderr };
}

async function waitForPortFile(portFile: string): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(portFile)) {
      const port = Number.parseInt(readFileSync(portFile, "utf8"), 10);
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    }
    await delay(50);
  }
  throw new Error("registry did not write a port file");
}

describe("plugin update unchanged Docker E2E", () => {
  it("seeds current plugin install ledger state before checking config stability", () => {
    const runner = readFileSync(PLUGIN_UPDATE_DOCKER_SCRIPT, "utf8");
    const scenario = readFileSync(PLUGIN_UPDATE_SCENARIO_SCRIPT, "utf8");
    const probe = readFileSync(PLUGIN_UPDATE_PROBE_SCRIPT, "utf8");

    expect(runner).toContain("scripts/e2e/lib/plugin-update/unchanged-scenario.sh");
    expect(scenario).toContain('node "$probe" seed');
    expect(probe).toContain("writeJson(process.env.OPENCLAW_CONFIG_PATH, { plugins: {} });");
    expect(probe).not.toContain(
      "writeJson(process.env.OPENCLAW_CONFIG_PATH, { plugins: { installs",
    );
    expect(probe).toContain("installRecords: {");
    expect(probe).toContain('"lossless-claw": {');
  });

  it("bounds the update command and prints diagnostics on hangs", () => {
    const script = readFileSync(PLUGIN_UPDATE_SCENARIO_SCRIPT, "utf8");

    expect(script).toContain("OPENCLAW_PLUGIN_UPDATE_TIMEOUT_SECONDS");
    expect(script).toContain("registry_port_file=/tmp/openclaw-e2e-registry.port");
    expect(script).toContain(
      'node scripts/e2e/lib/plugin-update/registry-server.mjs "$registry_port_file"',
    );
    expect(script).toContain(
      'export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$registry_port_file")"',
    );
    expect(script).toContain('export npm_config_registry="$NPM_CONFIG_REGISTRY"');
    expect(script).toContain(
      "openclaw_e2e_read_positive_int_env OPENCLAW_PLUGIN_UPDATE_TIMEOUT_SECONDS 180",
    );
    expect(script).toContain(
      'openclaw_e2e_maybe_timeout "${plugin_update_timeout_seconds}s" node "$entry" plugins update',
    );
    expect(script).not.toContain(
      'plugin_update_timeout_seconds="${OPENCLAW_PLUGIN_UPDATE_TIMEOUT_SECONDS:-180}"',
    );
    expect(script).not.toMatch(
      /^\s*timeout "\$\{plugin_update_timeout_seconds\}s" node "\$entry"/mu,
    );
    expect(script).toContain('"--- plugin update output ---"');
    expect(script).toContain('"--- local registry output ---"');
    expect(script).toContain("openclaw_e2e_print_log /tmp/plugin-update-output.log");
    expect(script).toContain("openclaw_e2e_print_log /tmp/openclaw-e2e-registry.log");
    expect(script).not.toContain("cat /tmp/plugin-update-output.log");
    expect(script).not.toContain("cat /tmp/openclaw-e2e-registry.log");
  });

  it("serves plugin metadata from an ephemeral registry port", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-registry-"));
    const portFile = path.join(root, "registry.port");
    const child = spawn("node", [PLUGIN_UPDATE_REGISTRY_SCRIPT, portFile], {
      stdio: "ignore",
    });
    try {
      const port = await waitForPortFile(portFile);

      const response = await fetch(`http://127.0.0.1:${port}/@example%2flossless-claw`);
      expect(response.status).toBe(200);
      const metadata = (await response.json()) as {
        versions?: Record<string, { dist?: { tarball?: string } }>;
      };
      expect(metadata.versions?.["0.9.0"]?.dist?.tarball).toBe(
        `http://127.0.0.1:${port}/@example/lossless-claw/-/lossless-claw-0.9.0.tgz`,
      );
    } finally {
      child.kill("SIGTERM");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds assert-output diagnostics to the saved command log tail", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-probe-"));
    const logPath = path.join(root, "plugin-update-output.log");
    try {
      writeFileSync(
        logPath,
        `DO_NOT_PRINT_OLD_PLUGIN_UPDATE_LOG\n${"filler line\n".repeat(12 * 1024)}missing marker tail`,
        "utf8",
      );

      const result = runProbeFileStatus("assert-output", logPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Expected up-to-date output missing");
      expect(result.stderr).toContain("Output tail:");
      expect(result.stderr).toContain("missing marker tail");
      expect(result.stderr).not.toContain("DO_NOT_PRINT_OLD_PLUGIN_UPDATE_LOG");
      expect(result.stderr.length).toBeLessThan(80 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects unexpected download output before a large log tail", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-probe-"));
    const logPath = path.join(root, "plugin-update-output.log");
    try {
      writeFileSync(
        logPath,
        [
          "Downloading @example/lossless-claw",
          "filler line\n".repeat(12 * 1024),
          "lossless-claw is up to date (0.9.0).",
        ].join("\n"),
        "utf8",
      );

      const result = runProbeFileStatus("assert-output", logPath);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unexpected npm download/reinstall path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for the local registry process during cleanup", () => {
    const script = readFileSync(PLUGIN_UPDATE_SCENARIO_SCRIPT, "utf8");

    expect(script).toContain('openclaw_e2e_stop_process "${registry_pid:-}"');
    expect(script).not.toContain('kill "$registry_pid"');
  });

  it("bounds corrupt plugin update commands and prints diagnostics on hangs", () => {
    const script = readFileSync(CORRUPT_UPDATE_SCENARIO_SCRIPT, "utf8");

    expect(script).toContain('plugins install "npm:@openclaw/demo-corrupt-plugin@0.0.1" --force');
    expect(script).toContain("config set plugins.allow '[\"demo-corrupt-plugin\"]'");
    expect(script).toContain("OPENCLAW_UPDATE_CORRUPT_PLUGIN_TIMEOUT_SECONDS");
    expect(script).toContain(
      "openclaw_e2e_read_positive_int_env OPENCLAW_UPDATE_CORRUPT_PLUGIN_TIMEOUT_SECONDS 900",
    );
    expect(script).toContain("OPENCLAW_UPDATE_CORRUPT_PLUGIN_STEP_TIMEOUT_SECONDS");
    expect(script).toContain(
      "default_update_step_timeout_seconds=$((10#$update_timeout_seconds - 30))",
    );
    expect(script).not.toContain(
      'update_timeout_seconds="${OPENCLAW_UPDATE_CORRUPT_PLUGIN_TIMEOUT_SECONDS:-900}"',
    );
    expect(
      script.match(/openclaw_e2e_maybe_timeout "\$\{update_timeout_seconds\}s" \\/gu)?.length,
    ).toBe(2);
    expect(script).toContain("--channel beta");
    expect(script.match(/--timeout "\$update_step_timeout_seconds"/g)).toHaveLength(2);
    expect(script).toContain("OPENCLAW_UPDATE_POST_CORE=1");
    expect(script).not.toContain(
      'node "$entry" update --channel beta --tag "${OPENCLAW_CURRENT_PACKAGE_TGZ',
    );
    expect(script).toContain(
      "openclaw update failed or timed out after ${update_timeout_seconds}s",
    );
    expect(script).toContain(
      "updated OpenClaw entry failed or timed out after ${update_timeout_seconds}s",
    );
    expect(script.match(/openclaw_e2e_print_log \/tmp\/openclaw-update-corrupt-/g)).toHaveLength(8);
    expect(script).not.toContain("cat /tmp/openclaw-update-corrupt-");
    expect(script.match(/assert-disabled-policy-preserved/g)).toHaveLength(2);
  });

  it("requires corrupt update failures to preserve the explicit allow policy", () => {
    expect(() =>
      runProbe("assert-disabled-policy-preserved", {
        plugins: {
          allow: [CORRUPT_PLUGIN_ID],
          entries: { [CORRUPT_PLUGIN_ID]: { enabled: false } },
        },
      }),
    ).not.toThrow();

    const revokedPolicy = runProbeStatus("assert-disabled-policy-preserved", {
      plugins: {
        entries: { [CORRUPT_PLUGIN_ID]: { enabled: false } },
      },
    });
    expect(revokedPolicy.status).not.toBe(0);
    expect(revokedPolicy.stderr).toContain("expected plugins.allow to preserve");
  });

  it("requires disabled-after-failure corrupt plugin updates to stay warnings", () => {
    const disabledAfterFailure = {
      status: "ok",
      npm: {
        outcomes: [
          {
            pluginId: CORRUPT_PLUGIN_ID,
            status: "skipped",
            message: `Disabled "${CORRUPT_PLUGIN_ID}" after plugin update failure; OpenClaw will continue without it. Failed to update ${CORRUPT_PLUGIN_ID}: registry timeout`,
          },
        ],
      },
    };

    const acceptedOkResult = runProbeStatus("assert-corrupt-plugin-result", disabledAfterFailure);

    expect(acceptedOkResult.status).not.toBe(0);
    expect(acceptedOkResult.stderr).toContain("expected clean or repaired corrupt plugin state");
    expect(() =>
      runProbe("assert-corrupt-plugin-result", {
        ...disabledAfterFailure,
        status: "warning",
        warnings: [
          {
            pluginId: CORRUPT_PLUGIN_ID,
            message:
              `Plugin "${CORRUPT_PLUGIN_ID}" could not be processed after the core update: ` +
              expectDefined(
                disabledAfterFailure.npm.outcomes[0],
                "corrupt plugin update failure outcome",
              ).message +
              " Run openclaw update repair to retry post-update plugin repair. " +
              `Run openclaw plugins inspect ${CORRUPT_PLUGIN_ID} --runtime --json for details.`,
          },
        ],
      }),
    ).not.toThrow();
  });
});

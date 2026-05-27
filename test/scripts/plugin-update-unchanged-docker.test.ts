import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_UPDATE_DOCKER_SCRIPT = "scripts/e2e/plugin-update-unchanged-docker.sh";
const PLUGIN_UPDATE_SCENARIO_SCRIPT = "scripts/e2e/lib/plugin-update/unchanged-scenario.sh";
const CORRUPT_UPDATE_SCENARIO_SCRIPT =
  "scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh";
const PLUGIN_UPDATE_PROBE_SCRIPT = "scripts/e2e/lib/plugin-update/probe.mjs";
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
    expect(script).toContain(
      'openclaw_e2e_maybe_timeout "${plugin_update_timeout_seconds}s" node "$entry" plugins update',
    );
    expect(script).not.toMatch(/^\s*timeout "\$\{plugin_update_timeout_seconds\}s" node "\$entry"/mu);
    expect(script).toContain('"--- plugin update output ---"');
    expect(script).toContain('"--- local registry output ---"');
  });

  it("bounds corrupt plugin update commands and prints diagnostics on hangs", () => {
    const script = readFileSync(CORRUPT_UPDATE_SCENARIO_SCRIPT, "utf8");

    expect(script).toContain("OPENCLAW_UPDATE_CORRUPT_PLUGIN_TIMEOUT_SECONDS");
    expect(
      script.match(/openclaw_e2e_maybe_timeout "\$\{update_timeout_seconds\}s" \\/gu)
        ?.length,
    ).toBe(2);
    expect(script).toContain("--channel beta");
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
  });

  it("requires disabled-after-failure corrupt plugin updates to stay warnings", () => {
    const disabledAfterFailure = {
      status: "ok",
      npm: {
        outcomes: [
          {
            pluginId: CORRUPT_PLUGIN_ID,
            status: "skipped",
            message:
              `Disabled "${CORRUPT_PLUGIN_ID}" after plugin update failure; OpenClaw will continue without it. Failed to update ${CORRUPT_PLUGIN_ID}: registry timeout`,
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
              disabledAfterFailure.npm.outcomes[0].message +
              " Run openclaw doctor --fix to attempt automatic repair. " +
              `Run openclaw plugins inspect ${CORRUPT_PLUGIN_ID} --runtime --json for details.`,
          },
        ],
      }),
    ).not.toThrow();
  });
});

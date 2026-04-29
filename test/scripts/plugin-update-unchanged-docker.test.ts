import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PLUGIN_UPDATE_DOCKER_SCRIPT = "scripts/e2e/plugin-update-unchanged-docker.sh";
const PLUGIN_UPDATE_SCENARIO_SCRIPT = "scripts/e2e/lib/plugin-update/unchanged-scenario.sh";
const PLUGIN_UPDATE_PROBE_SCRIPT = "scripts/e2e/lib/plugin-update/probe.mjs";

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
      'timeout "${plugin_update_timeout_seconds}s" node "$entry" plugins update',
    );
    expect(script).toContain('"--- plugin update output ---"');
    expect(script).toContain('"--- local registry output ---"');
  });
});

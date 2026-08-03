// Test Live Models Docker tests cover direct live model Docker script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(import.meta.dirname, "../../scripts/test-live-models-docker.sh");

describe("scripts/test-live-models-docker.sh", () => {
  it("validates optional live model limits before auth or Docker setup", () => {
    const script = fs.readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('LIVE_MAX_MODELS="${OPENCLAW_LIVE_MAX_MODELS:-}"');
    expect(script).toContain('[[ -n "$LIVE_MAX_MODELS" && ! "$LIVE_MAX_MODELS" =~ ^\\+?[0-9]+$ ]]');
    expect(script).toContain(
      'openclaw_live_read_positive_int_env OPENCLAW_LIVE_MODEL_TIMEOUT_MS "$LIVE_MODEL_TIMEOUT_MS"',
    );
    expect(script).toContain('-e OPENCLAW_LIVE_MAX_MODELS="$LIVE_MAX_MODELS"');
    expect(script).toContain('-e OPENCLAW_LIVE_MODEL_TIMEOUT_MS="$LIVE_MODEL_TIMEOUT_MS"');
  });

  it.each([
    ["max models", "OPENCLAW_LIVE_MAX_MODELS", "3models"],
    ["model timeout", "OPENCLAW_LIVE_MODEL_TIMEOUT_MS", "45s"],
  ])("rejects invalid %s values before live Docker setup", (_label, envName, value) => {
    const result = spawnSync("bash", [SCRIPT_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        [envName]: value,
      },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("docker");
    expect(result.stderr).not.toContain("Cannot find package 'tsx'");
  });
});

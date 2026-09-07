import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("live model Docker wrappers", () => {
  it.each([
    ["test-live-gateway-models-docker.sh", "OPENCLAW_LIVE_GATEWAY_MAX_MODELS", "two"],
    ["test-live-gateway-models-docker.sh", "OPENCLAW_LIVE_GATEWAY_STEP_TIMEOUT_MS", "45s"],
    ["test-live-gateway-models-docker.sh", "OPENCLAW_LIVE_GATEWAY_MODEL_TIMEOUT_MS", "90s"],
    ["test-live-models-docker.sh", "OPENCLAW_LIVE_MAX_MODELS", "3models"],
    ["test-live-models-docker.sh", "OPENCLAW_LIVE_MODEL_TIMEOUT_MS", "45s"],
  ])("guards validation and Docker forwarding for %s %s", (script, envName, value) => {
    const scriptPath = path.resolve(import.meta.dirname, `../../scripts/${script}`);
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: { ...process.env, [envName]: value },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`invalid ${envName}: ${value}`);
    expect(result.stderr).not.toContain("docker");
    expect(result.stderr).not.toContain("Cannot find package 'tsx'");
    expect(fs.readFileSync(scriptPath, "utf8")).toContain(
      `-e ${envName}="$${envName.replace("OPENCLAW_", "")}"`,
    );
  });
});

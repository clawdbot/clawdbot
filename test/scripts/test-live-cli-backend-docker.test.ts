import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../../scripts/test-live-cli-backend-docker.sh",
);

function readForwardedDockerEnvVars(): string[] {
  const script = fs.readFileSync(SCRIPT_PATH, "utf8");
  return Array.from(script.matchAll(/-e\s+([A-Z0-9_]+)=/g), (match) => match[1] ?? "");
}

describe("scripts/test-live-cli-backend-docker.sh", () => {
  it("forwards both fresh and resume CLI arg overrides into the Docker container", () => {
    const forwardedVars = readForwardedDockerEnvVars();

    expect(forwardedVars).toContain("OPENCLAW_LIVE_CLI_BACKEND_ARGS");
    expect(forwardedVars).toContain("OPENCLAW_LIVE_CLI_BACKEND_RESUME_ARGS");
    expect(forwardedVars).toContain("OPENCLAW_TEST_CONSOLE");
  });
});

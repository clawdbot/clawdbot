// Covers the Docker E2E guard that keeps continuous-integration containers out
// of the public telemetry aggregates.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const CONTAINER_HELPER_PATH = "scripts/lib/docker-e2e-container.sh";

/** Returns the docker run arguments the helper injects for the given caller args. */
function injectedRunArgs(callerArgs: string[], env: Record<string, string> = {}): string[] {
  const script = `
set -euo pipefail
source ${CONTAINER_HELPER_PATH}
docker_e2e_docker_run_resource_args ${callerArgs.map((arg) => `'${arg}'`).join(" ")}
printf '%s\\n' "\${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}"
`;
  return execFileSync("bash", ["-lc", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
    .split("\n")
    .filter(Boolean);
}

describe("docker e2e update-check suppression", () => {
  it("suppresses automatic update checks inside every container", () => {
    const args = injectedRunArgs(["-d", "--name", "openclaw-e2e", "openclaw:test"]);

    expect(args).toContain("-e");
    expect(args).toContain("OPENCLAW_NO_AUTO_UPDATE=1");
  });

  it("still suppresses when resource limits are disabled", () => {
    const args = injectedRunArgs(["-d", "openclaw:test"], {
      OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS: "1",
    });

    expect(args).toEqual(["-e", "OPENCLAW_NO_AUTO_UPDATE=1"]);
  });

  it("keeps a caller-provided value so update lanes stay in control", () => {
    for (const callerArgs of [
      ["-e", "OPENCLAW_NO_AUTO_UPDATE=0", "openclaw:test"],
      ["-eOPENCLAW_NO_AUTO_UPDATE=0", "openclaw:test"],
      ["--env", "OPENCLAW_NO_AUTO_UPDATE", "openclaw:test"],
      ["--env=OPENCLAW_NO_AUTO_UPDATE=0", "openclaw:test"],
    ]) {
      expect(injectedRunArgs(callerArgs)).not.toContain("OPENCLAW_NO_AUTO_UPDATE=1");
    }
  });

  it("does not mistake an image or unrelated flag value for the suppression variable", () => {
    const args = injectedRunArgs(["-e", "SOMETHING_ELSE=1", "OPENCLAW_NO_AUTO_UPDATE", "-d"]);

    expect(args).toContain("OPENCLAW_NO_AUTO_UPDATE=1");
  });
});

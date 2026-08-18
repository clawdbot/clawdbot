import { describe, expect, it } from "vitest";
import { parseInspectJson } from "./crabbox-worker-inspect.js";

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: "cbx_012345abcdef", state: "RUNNING", ...overrides });
}

describe("Crabbox worker inspect", () => {
  it("projects lifecycle facts without retaining provider transport details", () => {
    expect(
      parseInspectJson(
        inspectJson({
          providerMetadata: { instanceProfileAttached: false },
          ready: true,
          sshHost: "worker.example.test",
          sshPort: 2222,
          sshKey: "/tmp/provider-owned-key",
        }),
      ),
    ).toStrictEqual({
      id: "cbx_012345abcdef",
      state: "running",
      tailscaleEnabled: false,
      awsInstanceProfileAttached: false,
      ready: true,
    });
  });
});

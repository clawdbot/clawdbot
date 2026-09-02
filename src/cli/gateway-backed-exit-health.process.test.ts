// Process coverage for health failures and unreachable Gateway commands.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getFreePort } from "../test-utils/ports.js";
import {
  prepareUnreachableGatewayCliFixture,
  runIsolatedGatewayCli,
  snapshotSharedStateArtifacts,
  tempDirs,
  UNREACHABLE_GATEWAY_URL,
} from "./gateway-backed-exit.process.test-support.js";
import { startRateLimitedGateway } from "./gateway-backed-exit.test-helpers.js";

function expectUnreachableGatewayTransportFailure(
  result: Awaited<ReturnType<typeof runIsolatedGatewayCli>>,
  output: "json" | "text",
): void {
  expect(result).toMatchObject({ code: 1, signal: null });
  if (output === "json") {
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: expect.stringContaining("Gateway not reachable"),
      },
      gateway: { url: UNREACHABLE_GATEWAY_URL },
    });
    return;
  }
  expect(result.stderr).toContain("Gateway not reachable");
  expect(result.stderr).toContain(UNREACHABLE_GATEWAY_URL);
  expect(result.stderr).not.toContain("gateway timeout");
}

describe("gateway-backed CLI process exit", () => {
  // One child per case: the deadlock guard is sized against a single cold CLI start.
  it.each(
    [
      {
        label: "root-health-json",
        args: ["health", "--json", "--timeout", "250"],
        output: "json" as const,
      },
      {
        label: "gateway-health-text",
        args: ["gateway", "health", "--timeout", "250"],
        output: "text" as const,
      },
      {
        label: "gateway-health-json",
        args: ["gateway", "health", "--json", "--timeout", "250"],
        output: "json" as const,
      },
      {
        label: "gateway-suspend-json",
        args: ["gateway", "suspend", "--json", "--timeout", "250"],
        output: "json" as const,
      },
      {
        label: "gateway-resume-json",
        args: ["gateway", "resume", "suspension-1", "--json", "--timeout", "250"],
        output: "json" as const,
      },
    ].flatMap((command) =>
      [
        { stateLabel: "absent", seeded: false },
        { stateLabel: "seeded", seeded: true },
      ].map((state) => ({
        args: command.args,
        label: command.label,
        output: command.output,
        seeded: state.seeded,
        stateLabel: state.stateLabel,
      })),
    ),
  )(
    "leaves $stateLabel shared state byte-identical after unreachable $label",
    async ({ label, args, output, seeded, stateLabel }) => {
      const fixture = await prepareUnreachableGatewayCliFixture({
        label: `${label}-${stateLabel}`,
        seeded,
      });
      const before = await snapshotSharedStateArtifacts(fixture.stateDir);
      expect(Object.keys(before).includes("openclaw.sqlite")).toBe(seeded);

      const result = await runIsolatedGatewayCli({ ...fixture, args });

      expectUnreachableGatewayTransportFailure(result, output);
      expect(await snapshotSharedStateArtifacts(fixture.stateDir)).toEqual(before);
    },
  );

  it("keeps gateway auth failures machine-readable through the real health entry point", async () => {
    const root = tempDirs.make("openclaw-gateway-auth-json-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const port = await getFreePort();
    await fs.mkdir(stateDir, { recursive: true });

    const result = await runIsolatedGatewayCli({
      args: ["health", "--json", "--timeout", "250"],
      root,
      stateDir,
      configPath,
      env: { OPENCLAW_GATEWAY_PORT: String(port) },
    });

    expect(result, result.stderr).toMatchObject({ code: 1, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: expect.stringContaining("requires"),
      },
    });
  });

  it("preserves pre-hello rate-limit details through the real health entry point", async () => {
    const root = tempDirs.make("openclaw-gateway-rate-limit-json-");
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const gateway = await startRateLimitedGateway();
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        gateway: {
          mode: "remote",
          remote: { url: gateway.url, token: "test-token" },
        },
      }),
    );

    const result = await runIsolatedGatewayCli({
      args: ["health", "--json", "--timeout", "2000"],
      root,
      stateDir,
      configPath,
    });

    expect(result, result.stderr).toMatchObject({ code: 1, signal: null, stderr: "" });
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        type: "gateway_request_error",
        code: "AUTH_RATE_LIMITED",
        message:
          "Gateway authentication is temporarily rate-limited. Wait for the temporary lockout to expire, then retry.",
        retryable: true,
        retryAfterMs: 60_000,
      },
      gateway: { reachable: true },
    });
    expect(result.stdout).not.toContain("gateway.remote.token");
    expect(result.stdout).not.toContain("devices rotate");
  });
});

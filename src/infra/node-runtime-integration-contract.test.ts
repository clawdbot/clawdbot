// Cross-language fixture pins the catalog/admission boundary shared with the Rust node runtime.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isNodeCommandAllowed,
  resolveNodeCommandAllowlist,
} from "../gateway/node-command-policy.js";
import { normalizeNodeApprovalSurfaceList } from "./node-pairing-surface.js";

type IntegrationFixture = {
  version: number;
  declaredCapabilities: string[];
  expectedCapabilities: string[];
  declaredCommands: string[];
  expectedCommands: string[];
  gatewayPolicy: {
    allow: string[];
    deny: string[];
  };
  invocations: Array<{
    command: string;
    gatewayDelivery: "deliver" | "reject";
    gatewayReason?: string;
    localAdmission: "allow" | "deny" | "not-evaluated";
    expected?: "success" | "failure";
    errorCode?: string;
    errorMessage?: string;
  }>;
};

function loadFixture(): IntegrationFixture {
  const fixturePath = path.join(
    process.cwd(),
    "test",
    "fixtures",
    "node-runtime-integration-contract.json",
  );
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as IntegrationFixture;
}

describe("node runtime integration contract", () => {
  it("keeps Gateway authority ahead of node-local admission", () => {
    const fixture = loadFixture();
    expect(fixture.version).toBe(2);
    const declaredCapabilities = [
      ...new Set(normalizeNodeApprovalSurfaceList(fixture.declaredCapabilities)),
    ].toSorted();
    expect(declaredCapabilities).toEqual(fixture.expectedCapabilities);
    const declaredCommands = [
      ...new Set(normalizeNodeApprovalSurfaceList(fixture.declaredCommands)),
    ].toSorted();
    expect(declaredCommands).toEqual(fixture.expectedCommands);

    const allowlist = resolveNodeCommandAllowlist({
      gateway: { nodes: { commands: fixture.gatewayPolicy } },
    });

    for (const invocation of fixture.invocations) {
      const decision = isNodeCommandAllowed({
        command: invocation.command,
        declaredCommands,
        allowlist,
      });
      expect(decision.ok ? "deliver" : "reject").toBe(invocation.gatewayDelivery);
      if (!decision.ok) {
        expect(decision.reason).toBe(invocation.gatewayReason);
        expect(invocation.localAdmission).toBe("not-evaluated");
      }
    }
  });
});

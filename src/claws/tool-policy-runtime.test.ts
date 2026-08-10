import { describe, expect, it, vi } from "vitest";
import {
  prepareClawToolPolicyConsent,
  resolveClawToolPolicyConsent,
} from "./tool-policy-runtime.js";

function prepare(schemaVersion: "openclaw.clawInstallRecord.v1" | "openclaw.clawInstallRecord.v2") {
  const tools = { profile: schemaVersion.endsWith(".v2") ? "full" : "coding", allow: ["read"] };
  const readSchemaVersions = vi.fn(
    () =>
      ({
        kind: "ready",
        schemaVersions: new Map([["worker", { kind: "ok" as const, schemaVersion }]]),
      }) as const,
  );
  prepareClawToolPolicyConsent(
    { agents: { list: [{ id: "worker", tools }] } },
    { readSchemaVersions },
  );
  return { tools, readSchemaVersions };
}

describe("resolveClawToolPolicyConsent", () => {
  it("leaves ordinary non-Claw profiles dynamic", () => {
    const tools = { profile: "coding" };
    expect(
      resolveClawToolPolicyConsent({
        agentTools: tools,
        agentId: "worker",
        profile: "coding",
        ownsProfile: true,
        hasAgentAllowlist: false,
      }),
    ).toEqual({ frozen: false });
  });

  it("fails closed for prepared legacy Claw profile provenance", () => {
    const { tools } = prepare("openclaw.clawInstallRecord.v1");

    expect(() =>
      resolveClawToolPolicyConsent({
        agentTools: tools,
        agentId: "worker",
        profile: "coding",
        ownsProfile: true,
        hasAgentAllowlist: true,
      }),
    ).toThrow("uses a legacy dynamic tool policy");
  });

  it("reuses prepared current provenance without runtime reads", () => {
    const { tools, readSchemaVersions } = prepare("openclaw.clawInstallRecord.v2");
    const resolve = () =>
      resolveClawToolPolicyConsent({
        agentTools: tools,
        agentId: "worker",
        profile: "full",
        ownsProfile: true,
        hasAgentAllowlist: true,
      });

    expect(resolve()).toEqual({ frozen: true });
    expect(resolve()).toEqual({ frozen: true });
    expect(readSchemaVersions).toHaveBeenCalledTimes(1);
  });

  it("isolates invalid provenance to its owning agent", () => {
    const validTools = { profile: "full" as const, allow: ["read"] };
    const invalidTools = { profile: "full" as const, allow: ["read"] };
    const invalidError = new Error("unsupported schema version");
    prepareClawToolPolicyConsent(
      {
        agents: {
          list: [
            { id: "valid", tools: validTools },
            { id: "invalid", tools: invalidTools },
          ],
        },
      },
      {
        readSchemaVersions: () =>
          ({
            kind: "ready",
            schemaVersions: new Map([
              [
                "valid",
                { kind: "ok" as const, schemaVersion: "openclaw.clawInstallRecord.v2" as const },
              ],
              ["invalid", { kind: "error" as const, error: invalidError }],
            ]),
          }) as const,
      },
    );

    expect(
      resolveClawToolPolicyConsent({
        agentTools: validTools,
        agentId: "valid",
        profile: "full",
        ownsProfile: true,
        hasAgentAllowlist: true,
      }),
    ).toEqual({ frozen: true });
    expect(() =>
      resolveClawToolPolicyConsent({
        agentTools: invalidTools,
        agentId: "invalid",
        profile: "full",
        ownsProfile: true,
        hasAgentAllowlist: true,
      }),
    ).toThrow("Cannot verify the installed tool authority");
  });

  it("does not treat an inherited global profile as Claw-owned authority", () => {
    expect(
      resolveClawToolPolicyConsent({
        agentId: "worker",
        profile: "coding",
        ownsProfile: false,
        hasAgentAllowlist: false,
      }),
    ).toEqual({ frozen: false });
  });
});

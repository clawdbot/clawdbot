import { describe, expect, it, vi } from "vitest";
import type { CanonicalGatewayReadinessResult } from "../gateway/server/readiness.js";
import {
  hostingProfilesInspectCommand,
  hostingProfilesListCommand,
  hostingProfilesValidateCommand,
} from "./hosting-profiles.js";

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe("hosting profile catalog commands", () => {
  it("lists the standard catalog as stable JSON", () => {
    const runtime = createRuntime();

    hostingProfilesListCommand({ json: true }, runtime);

    const result = JSON.parse(runtime.log.mock.calls[0]?.[0] ?? "{}") as {
      contractVersion?: number;
      profiles?: Array<{ id: string; profileConditions: string[] }>;
    };
    expect(result.contractVersion).toBe(1);
    expect(result.profiles?.map((profile) => profile.id)).toEqual([
      "local",
      "container",
      "reverse-proxy",
      "node-mode",
    ]);
    expect(
      result.profiles?.find((profile) => profile.id === "container")?.profileConditions,
    ).toEqual(["ProfileSelected", "ContainerStateReady"]);
  });

  it("renders a concise human catalog", () => {
    const runtime = createRuntime();

    hostingProfilesListCommand({}, runtime);

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain("PROFILE");
    expect(output).toContain("reverse-proxy");
    expect(output).toContain("Gateway behind a trusted identity proxy.");
  });

  it("inspects one profile with conditions and criteria", () => {
    const runtime = createRuntime();

    hostingProfilesInspectCommand("node-mode", {}, runtime);

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain("Profile: node-mode");
    expect(output).toContain("- NodePairingReady");
    expect(output).toContain("- openclaw.model-route-ready");
    expect(output).toContain("- openclaw.scheduler-ready");
  });

  it("returns one descriptor as stable JSON", () => {
    const runtime = createRuntime();

    hostingProfilesInspectCommand("container", { json: true }, runtime);

    const result = JSON.parse(runtime.log.mock.calls[0]?.[0] ?? "{}") as {
      contractVersion?: number;
      profile?: { id?: string; description?: string };
    };
    expect(result).toMatchObject({
      contractVersion: 1,
      profile: {
        id: "container",
        description: "Gateway directly reachable through a container listener.",
      },
    });
  });

  it("rejects an unknown profile without emitting a partial descriptor", () => {
    const runtime = createRuntime();

    hostingProfilesInspectCommand("managed", { json: true }, runtime);

    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      'Unknown hosting profile "managed". Use "local", "container", "reverse-proxy", "node-mode".',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

const containerReady: CanonicalGatewayReadinessResult = {
  contractVersion: 1,
  evaluatedAtMs: 1_000,
  identity: { producerRef: "openclaw/gateway/current", subjects: [] },
  ready: true,
  failing: [],
  uptimeMs: 1_000,
  conditions: [
    {
      type: "ProfileSelected",
      subjectRef: "openclaw/hosting-profile/selected",
      status: "True",
      requirement: "required",
      reason: "ProfileSelected",
      message: "Runtime selected the container hosting profile.",
    },
    {
      type: "ContainerStateReady",
      subjectRef: "openclaw/gateway/current",
      status: "True",
      requirement: "required",
      reason: "ContainerStateReady",
      message: "The Gateway listener is reachable.",
    },
  ],
  failures: [],
  advisories: [],
  profileContractVersion: 1,
  profile: "container",
  profileSource: "config",
};

describe("hosting profile validation", () => {
  it("validates the active profile through canonical readiness", async () => {
    const runtime = createRuntime();
    const callReady = vi.fn().mockResolvedValue(containerReady);

    await hostingProfilesValidateCommand("container", { json: true, timeoutMs: 2500 }, runtime, {
      callReady,
    });

    expect(callReady).toHaveBeenCalledWith({ timeoutMs: 2500 });
    const result = JSON.parse(runtime.log.mock.calls[0]?.[0] ?? "{}") as {
      conformant?: boolean;
      ready?: boolean;
      activeProfile?: string;
      readiness?: { profile?: string };
    };
    expect(result).toMatchObject({
      contractVersion: 1,
      conformant: true,
      ready: true,
      expectedProfile: "container",
      activeProfile: "container",
      readiness: { profile: "container" },
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("distinguishes a conformant profile from a non-ready runtime", async () => {
    const runtime = createRuntime();
    await hostingProfilesValidateCommand(undefined, {}, runtime, {
      callReady: async () => ({
        ...containerReady,
        ready: false,
        conditions: containerReady.conditions.map((condition) =>
          condition.type === "ContainerStateReady"
            ? { ...condition, status: "False", reason: "ContainerGatewayLoopback" }
            : condition,
        ),
        failures: ["ContainerGatewayLoopback"],
      }),
    });

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain("Conformant: yes");
    expect(output).toContain("Ready: no");
    expect(output).toContain("ContainerGatewayLoopback");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails conformance when the active profile does not match", async () => {
    const runtime = createRuntime();
    await hostingProfilesValidateCommand("reverse-proxy", { json: true }, runtime, {
      callReady: async () => containerReady,
    });

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain('"reason": "HostingProfileMismatch"');
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails conformance when a required profile condition is absent", async () => {
    const runtime = createRuntime();
    await hostingProfilesValidateCommand(undefined, { json: true }, runtime, {
      callReady: async () => ({
        ...containerReady,
        conditions: containerReady.conditions.filter(
          (condition) => condition.type !== "ContainerStateReady",
        ),
      }),
    });

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain('"reason": "HostingProfileConditionMissing"');
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when no profile is selected", async () => {
    const runtime = createRuntime();
    await hostingProfilesValidateCommand(undefined, {}, runtime, {
      callReady: async () => {
        const {
          profile: _profile,
          profileContractVersion: _version,
          ...unprofiled
        } = containerReady;
        return unprofiled as CanonicalGatewayReadinessResult;
      },
    });

    expect(runtime.log.mock.calls[0]?.[0]).toContain("HostingProfileNotSelected");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when the Gateway is unavailable", async () => {
    const runtime = createRuntime();
    await hostingProfilesValidateCommand("container", { json: true }, runtime, {
      callReady: async () => {
        throw new Error("connection refused");
      },
    });

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain('"reason": "GatewayReadinessUnavailable"');
    expect(output).toContain("connection refused");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("fails closed on malformed readiness evidence", async () => {
    const runtime = createRuntime();
    await hostingProfilesValidateCommand(undefined, { json: true }, runtime, {
      callReady: async () => ({ ready: true, profile: "container", conditions: null }),
    });

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain('"reason": "ReadinessContractMismatch"');
    expect(output).toContain('"reason": "ReadinessResultInvalid"');
    expect(output).toContain('"reason": "HostingProfileContractMismatch"');
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects incomplete canonical condition records", async () => {
    const runtime = createRuntime();
    await hostingProfilesValidateCommand(undefined, { json: true }, runtime, {
      callReady: async () => ({
        ...containerReady,
        conditions: [
          { type: "ProfileSelected", requirement: "required" },
          { type: "ContainerStateReady", requirement: "required" },
        ],
      }),
    });

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain('"reason": "ReadinessResultInvalid"');
    expect(output).toContain('"ready": false');
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects normalized but noncanonical Gateway profile identifiers", async () => {
    const runtime = createRuntime();
    await hostingProfilesValidateCommand(undefined, { json: true }, runtime, {
      callReady: async () => ({ ...containerReady, profile: "Container" }),
    });

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain('"reason": "HostingProfileUnknown"');
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});

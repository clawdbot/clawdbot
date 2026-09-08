import { describe, expect, it } from "vitest";
import {
  attachGatewayLocalUserIngress,
  prepareGatewayLocalUserIngress,
} from "../local-user-ingress.js";
import { resolveAgentRunSessionCreation } from "./session-creation-provenance.js";

function resolveWithIngress(
  localUserIngress: ReturnType<typeof prepareGatewayLocalUserIngress>,
  profileId?: string,
) {
  const client = profileId ? { authenticatedUserProfile: { profileId } } : {};
  attachGatewayLocalUserIngress(client, localUserIngress);
  return resolveAgentRunSessionCreation(client);
}

describe("agent run session creation provenance", () => {
  it("uses a proven Gateway profile id without retaining its display label", () => {
    const localUserIngress = prepareGatewayLocalUserIngress({
      authenticatedUserExpected: true,
      profile: { profileId: "profile-ada", displayName: "Ada" },
      isLocalClient: false,
    });

    expect(resolveWithIngress(localUserIngress, "profile-ada")).toEqual({
      via: "run",
      actor: { type: "human", source: "profile", id: "profile-ada" },
    });
    expect(localUserIngress.facts.invoker).toEqual({
      state: "present",
      kind: "person",
      rawPrincipalRef: "profile-ada",
      displayLabel: "Ada",
    });
  });

  it("uses the live canonical profile id after a connection profile merge", () => {
    const localUserIngress = prepareGatewayLocalUserIngress({
      authenticatedUserExpected: true,
      profile: { profileId: "profile-before-merge", displayName: "Ada" },
      isLocalClient: false,
    });

    expect(resolveWithIngress(localUserIngress, "profile-after-merge")).toEqual({
      via: "run",
      actor: { type: "human", source: "profile", id: "profile-after-merge" },
    });
    expect(localUserIngress.facts.invoker).toMatchObject({
      state: "present",
      rawPrincipalRef: "profile-before-merge",
    });
  });

  it("does not infer an actor for a profile-less wire client", () => {
    expect(resolveAgentRunSessionCreation({})).toEqual({ via: "run" });
  });

  it.each([
    {
      name: "paired device",
      input: {
        authMethod: "device-token" as const,
        authenticatedUserExpected: false,
        pairedDeviceId: "device-browser",
        isLocalClient: false,
      },
      expected: {
        ingress: expect.objectContaining({ rawSourceRef: "device-browser" }),
        assurance: [
          {
            kind: "device-proof",
            rawEvidenceRef: "device-browser",
            strength: "cryptographic",
          },
        ],
      },
    },
    {
      name: "shared secret",
      input: {
        authMethod: "token" as const,
        authenticatedUserExpected: false,
        isLocalClient: false,
      },
      expected: { ingress: expect.not.objectContaining({ rawSourceRef: expect.anything() }) },
    },
  ])("keeps a $name profile-less and unattributed", ({ input, expected }) => {
    const localUserIngress = prepareGatewayLocalUserIngress(input);

    expect(localUserIngress.facts).toEqual(expect.objectContaining(expected));
    expect(localUserIngress.facts.invoker).toBeUndefined();
    expect(resolveWithIngress(localUserIngress)).toEqual({ via: "run" });
  });

  it("keeps a trusted-proxy identity unknown when durable profile resolution is missing", () => {
    const localUserIngress = prepareGatewayLocalUserIngress({
      authMethod: "trusted-proxy",
      authenticatedUserExpected: true,
      isLocalClient: false,
    });

    expect(localUserIngress.facts).toMatchObject({
      ingress: { kind: "gateway-client", state: "present" },
      invoker: { state: "unknown" },
      assurance: [
        {
          kind: "trusted-proxy",
          rawEvidenceRef: "gateway-auth:trusted-proxy",
          strength: "boundary-verified",
        },
      ],
    });
    expect(resolveWithIngress(localUserIngress)).toEqual({ via: "run" });
  });

  it("records both durable-profile and trusted-proxy assurance for a profiled proxy user", () => {
    const localUserIngress = prepareGatewayLocalUserIngress({
      authMethod: "trusted-proxy",
      authenticatedUserExpected: true,
      profile: { profileId: "profile-proxy", displayName: "Proxy User" },
      isLocalClient: false,
    });

    expect(localUserIngress.facts.assurance).toEqual([
      {
        kind: "durable-profile",
        rawEvidenceRef: "profile-proxy",
        strength: "boundary-verified",
      },
      {
        kind: "trusted-proxy",
        rawEvidenceRef: "profile-proxy",
        strength: "boundary-verified",
      },
    ]);
  });

  it("keeps a bounded, redacted profile label transient for opt-in run auditing", () => {
    const secret = "sk-1234567890abcdef";
    const localUserIngress = prepareGatewayLocalUserIngress({
      authenticatedUserExpected: true,
      profile: {
        profileId: "profile-redacted",
        displayName: `Operator OPENAI_API_KEY=${secret} ${"x".repeat(256)}`,
      },
      isLocalClient: false,
    });

    const invoker = localUserIngress.facts.invoker;
    expect(invoker).toMatchObject({ state: "present" });
    if (invoker?.state !== "present") {
      throw new Error("expected present invoker");
    }
    expect(invoker.displayLabel).toContain("OPENAI_API_KEY=***");
    expect(invoker.displayLabel).not.toContain(secret);
    expect(invoker.displayLabel?.length).toBeLessThanOrEqual(128);
    expect(resolveWithIngress(localUserIngress, "profile-redacted")).toEqual({
      via: "run",
      actor: { type: "human", source: "profile", id: "profile-redacted" },
    });
  });
});

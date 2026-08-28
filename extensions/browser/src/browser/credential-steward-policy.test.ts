import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateCredentialStewardExposure,
  type CredentialStewardDecision,
} from "./credential-steward-policy.js";

type CredentialStewardFixture = {
  name: string;
  value?: unknown;
  valueParts?: string[];
  labels?: string[];
  expected: CredentialStewardDecision;
  rawMustNotContain?: string[];
};

const fixtures = JSON.parse(
  readFileSync("test/fixtures/credential-steward-redaction-cases.json", "utf8"),
) as CredentialStewardFixture[];

describe("Credential Steward redaction policy", () => {
  it.each(fixtures)("classifies and redacts $name", (fixture) => {
    const decision = evaluateCredentialStewardExposure({
      value: fixture.valueParts?.join("") ?? fixture.value,
      labels: fixture.labels,
    });

    expect(decision).toEqual(fixture.expected);
    for (const rawValue of fixture.rawMustNotContain ?? []) {
      expect(JSON.stringify(decision)).not.toContain(rawValue);
    }
  });

  it("classifies a PEM private-key marker without retaining its value", () => {
    const privateKeyMarker = ["-----BEGIN ", ["PRIVATE", "KEY"].join(" "), "-----"].join("");
    const rawValue = ["raw-", "private-key-value"].join("");
    const decision = evaluateCredentialStewardExposure({
      value: `${privateKeyMarker}\n${rawValue}\n${privateKeyMarker.replace("BEGIN", "END")}`,
    });

    expect(decision).toMatchObject({
      exposureKind: "credential_material",
      credentialClassesInvolved: ["private key"],
      blocked: true,
      reasonCode: "credential_material_detected",
    });
    expect(JSON.stringify(decision)).not.toContain(rawValue);
  });

  it("classifies opaque password-reset URL paths as bearer material", () => {
    const rawToken = "raw-reset-token-123456";
    const decision = evaluateCredentialStewardExposure({
      value: `https://accounts.example/password-reset/${rawToken}`,
    });

    expect(decision).toMatchObject({
      exposureKind: "credential_material",
      credentialClassesInvolved: ["token"],
      blocked: true,
      reasonCode: "credential_material_detected",
    });
    expect(JSON.stringify(decision)).not.toContain(rawToken);
  });

  it("fails closed without recursing forever on cyclic credential input", () => {
    const credential: Record<string, unknown> = { token: "raw-cycle-token-123456" };
    credential.self = credential;

    const decision = evaluateCredentialStewardExposure({ value: credential });

    expect(decision).toMatchObject({
      exposureKind: "credential_material",
      blocked: true,
      credentialClassesInvolved: ["token"],
    });
    expect(JSON.stringify(decision)).not.toContain("raw-cycle-token-123456");
  });
});

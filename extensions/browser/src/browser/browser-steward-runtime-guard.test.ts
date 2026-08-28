import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateBrowserStewardRuntimeGuard,
  redactBrowserStewardCredentialMaterial,
  shouldApplyBrowserStewardRuntimeGuard,
  resolveBrowserStewardProxyAction,
} from "./browser-steward-runtime-guard.js";

type BrowserStewardBoundaryFixture = {
  name: string;
  sessionKey?: string | null;
  browserExpected?: {
    kind: "browser_steward" | "other_agent" | "global" | "unscoped" | "unknown";
    ownerAgentId: string;
    affectedSession: string;
  };
  rawMustNotContain?: string[];
};

type CredentialStewardFixture = {
  name: string;
  value?: unknown;
  valueParts?: string[];
  labels?: string[];
  expected: {
    exposureKind: "none" | "credential_like" | "credential_material";
    credentialClassesInvolved: string[];
    dataSensitivity: "low" | "medium" | "critical";
    blocked: boolean;
    reasonCode: "no_credential_material" | "credential_like_label" | "credential_material_detected";
    redactedSummary: string;
  };
  rawMustNotContain?: string[];
};

const boundaryFixtures = JSON.parse(
  readFileSync("test/fixtures/session-steward-boundary-cases.json", "utf8"),
) as BrowserStewardBoundaryFixture[];
const credentialFixtures = JSON.parse(
  readFileSync("test/fixtures/credential-steward-redaction-cases.json", "utf8"),
) as CredentialStewardFixture[];
const browserBoundaryFixtures = boundaryFixtures.filter(
  (
    fixture,
  ): fixture is BrowserStewardBoundaryFixture & {
    browserExpected: NonNullable<BrowserStewardBoundaryFixture["browserExpected"]>;
  } => fixture.browserExpected !== undefined,
);

describe("Browser Steward runtime guard", () => {
  it("recognizes only exact Browser Steward agent session keys", () => {
    const boundaryKind = (sessionKey: string) =>
      evaluateBrowserStewardRuntimeGuard({ action: "status", agentSessionKey: sessionKey })
        .sessionBoundary.kind;
    expect(boundaryKind("agent:browser-session-credential-steward:abc")).toBe("browser_steward");
    expect(boundaryKind("agent:browser-session-credential-steward")).toBe("browser_steward");
    expect(boundaryKind("Agent:Browser-Session-Credential-Steward:Main")).toBe("browser_steward");
    expect(boundaryKind("agent:main:abc")).toBe("other_agent");
    expect(boundaryKind("agent:not-browser-session-credential-steward:main")).toBe("other_agent");
    expect(boundaryKind("agent:browser-session-credential-stewardish:main")).toBe("other_agent");
    expect(boundaryKind("agent:main:browser-session-credential-steward")).toBe("other_agent");
    expect(boundaryKind("agent:browser-session-credential-steward:")).toBe("unknown");
    expect(boundaryKind("browser-session-credential-steward")).toBe("unscoped");
  });

  it("enables the guard for Browser Steward global sessions by agent id", () => {
    expect(
      shouldApplyBrowserStewardRuntimeGuard({
        sessionKey: "global",
        agentId: "browser-session-credential-steward",
      }),
    ).toBe(true);
    expect(
      shouldApplyBrowserStewardRuntimeGuard({
        sessionKey: "global",
        agentId: "main",
      }),
    ).toBe(false);
  });

  it.each(browserBoundaryFixtures)("matches shared boundary fixture: $name", (fixture) => {
    const boundary = evaluateBrowserStewardRuntimeGuard({
      action: "status",
      agentSessionKey: fixture.sessionKey ?? undefined,
    }).sessionBoundary;
    expect(boundary).toEqual(fixture.browserExpected);
    for (const rawValue of fixture.rawMustNotContain ?? []) {
      expect(JSON.stringify(boundary)).not.toContain(rawValue);
    }
  });

  it("defaults sensitive mutation to approval_required", () => {
    expect(
      evaluateBrowserStewardRuntimeGuard({
        action: "navigate",
        profile: "work",
        agentSessionKey: "agent:main:direct:person-123",
      }),
    ).toMatchObject({
      boundaryDecision: "approval_required",
      approvalRequired: true,
      affectedBrowserProfile: "work",
      affectedSession: "agent:UNKNOWN:REDACTED",
      sessionBoundary: {
        kind: "other_agent",
        ownerAgentId: "UNKNOWN",
        affectedSession: "agent:UNKNOWN:REDACTED",
      },
      telemetryEvent: "browser_steward.approval_gate",
    });
    expect(
      JSON.stringify(
        evaluateBrowserStewardRuntimeGuard({
          action: "navigate",
          profile: "work",
          agentSessionKey: "agent:main:direct:person-123",
        }),
      ),
    ).not.toContain("person-123");
  });

  it("redacts untrusted credential-like action strings in decisions", () => {
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "Bearer SHOULD_NOT_APPEAR",
      agentSessionKey: "agent:browser-session-credential-steward:runtime-check",
    });

    expect(decision).toMatchObject({
      requestedAction: "unknown",
      credentialExposureKind: "credential_material",
      telemetryEvent: "browser_steward.blocked_credential_exposure",
    });
    expect(JSON.stringify(decision)).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("redacts credential-shaped browser profile values in decisions", () => {
    for (const profile of [
      "token=raw-profile-secret-123456",
      "sk-abcdefghijk",
      "ghp_abcdefghijk",
    ]) {
      const decision = evaluateBrowserStewardRuntimeGuard({
        action: "navigate",
        profile,
        agentSessionKey: "agent:browser-session-credential-steward:runtime-check",
      });

      expect(decision.affectedBrowserProfile).toBe("REDACTED");
      expect(JSON.stringify(decision)).not.toContain(profile);
    }
  });

  it("fails closed without recursing forever on cyclic credential input", () => {
    const credential: Record<string, unknown> = { token: "raw-cycle-token-123456" };
    credential.self = credential;

    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "act",
      agentSessionKey: "agent:browser-session-credential-steward:runtime-check",
      request: credential,
    });

    expect(decision).toMatchObject({
      credentialExposureKind: "credential_material",
      approvalRequired: true,
      telemetryEvent: "browser_steward.blocked_credential_exposure",
    });
    expect(JSON.stringify(decision)).not.toContain("raw-cycle-token-123456");
  });

  it("allows approved Browser Steward mutations with redacted session metadata", () => {
    expect(
      evaluateBrowserStewardRuntimeGuard({
        action: "open",
        approved: true,
        agentSessionKey: "agent:browser-session-credential-steward:runtime-check",
      }),
    ).toMatchObject({
      boundaryDecision: "allow",
      affectedSession: "agent:browser-session-credential-steward:REDACTED",
      sessionBoundary: {
        kind: "browser_steward",
        ownerAgentId: "browser-session-credential-steward",
      },
    });
  });

  it("rejects mismatched Browser Steward agent and session identities even when approved", () => {
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "navigate",
      approved: true,
      agentSessionKey: "agent:main:direct:opaque",
      agentId: "browser-session-credential-steward",
    });

    expect(decision).toMatchObject({
      boundaryDecision: "approval_required",
      approvalRequired: true,
      safeNextAction: "reject the mismatched Browser Steward session and agent identity",
      sessionBoundary: {
        kind: "other_agent",
        ownerAgentId: "UNKNOWN",
        affectedSession: "agent:UNKNOWN:REDACTED",
      },
    });
  });

  it("marks missing sessions as unknown", () => {
    expect(evaluateBrowserStewardRuntimeGuard({ action: "status" })).toMatchObject({
      affectedSession: "UNKNOWN",
      sessionBoundary: {
        kind: "unknown",
        ownerAgentId: "UNKNOWN",
      },
    });
  });

  it("allows read-only non-secret status", () => {
    expect(evaluateBrowserStewardRuntimeGuard({ action: "status" })).toMatchObject({
      boundaryDecision: "allow",
      approvalRequired: false,
      dataSensitivity: "low",
      credentialExposureKind: "none",
      credentialExposureReasonCode: "no_credential_material",
    });
  });

  it("maps browser proxy requests to Browser Steward actions", () => {
    expect(resolveBrowserStewardProxyAction({ method: "GET", path: "/" })).toBe("status");
    expect(resolveBrowserStewardProxyAction({ method: "GET", path: "/profiles" })).toBe("profiles");
    expect(resolveBrowserStewardProxyAction({ method: "POST", path: "/tabs/open" })).toBe("open");
    expect(resolveBrowserStewardProxyAction({ method: "POST", path: "/navigate" })).toBe(
      "navigate",
    );
    expect(resolveBrowserStewardProxyAction({ method: "POST", path: "/act" })).toBe("act");
    expect(resolveBrowserStewardProxyAction({ method: "DELETE", path: "/tabs/abc" })).toBe("close");
  });

  it("classifies secret-like input without returning the value", () => {
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "act",
      request: { kind: "type", text: "Bearer SHOULD_NOT_APPEAR" },
    });
    expect(decision).toMatchObject({
      approvalRequired: true,
      telemetryEvent: "browser_steward.blocked_credential_exposure",
      credentialExposureKind: "credential_material",
      credentialExposureReasonCode: "credential_material_detected",
      dataSensitivity: "critical",
    });
    expect(JSON.stringify(decision)).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("redacts credential values without hiding non-secret request structure", () => {
    const rawSecret = "raw-hook-secret-123456";
    const redacted = redactBrowserStewardCredentialMaterial({
      action: "act",
      target: "settings-form",
      request: {
        kind: "type",
        targetId: "field-1",
        text: rawSecret,
      },
    });

    expect(redacted).toEqual({
      action: "act",
      target: "settings-form",
      request: {
        kind: "type",
        targetId: "field-1",
        text: "REDACTED",
      },
    });
    expect(JSON.stringify(redacted)).not.toContain(rawSecret);
  });

  it("redacts OAuth authorization codes embedded in callback URLs", () => {
    const rawUrl = "https://auth.example/callback?code=raw-oauth-code-123456";
    const redacted = redactBrowserStewardCredentialMaterial({
      action: "navigate",
      url: rawUrl,
    });
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "navigate",
      request: { url: rawUrl },
    });

    expect(redacted).toEqual({ action: "navigate", url: "REDACTED" });
    expect(decision).toMatchObject({
      credentialExposureKind: "credential_material",
      approvalRequired: true,
      telemetryEvent: "browser_steward.blocked_credential_exposure",
    });
    expect(JSON.stringify(decision)).not.toContain("raw-oauth-code-123456");
  });

  it("does not classify ordinary code query parameters as credentials", () => {
    const rawUrl = "https://shop.example/redeem?code=SUMMER";
    const redacted = redactBrowserStewardCredentialMaterial({ url: rawUrl });
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "navigate",
      request: { url: rawUrl },
    });

    expect(redacted).toEqual({ url: "https://shop.example" });
    expect(decision).toMatchObject({
      credentialExposureKind: "none",
      approvalRequired: true,
      telemetryEvent: "browser_steward.approval_gate",
    });
  });

  it("does not expose opaque credential-bearing URL paths to policy hooks", () => {
    const rawUrl = "https://accounts.example/password-reset/raw-reset-token-123456";
    const redacted = redactBrowserStewardCredentialMaterial({
      action: "navigate",
      url: rawUrl,
    });
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "navigate",
      request: { url: rawUrl },
    });

    expect(redacted).toEqual({ action: "navigate", url: "REDACTED" });
    expect(decision).toMatchObject({
      credentialExposureKind: "credential_material",
      approvalRequired: true,
      telemetryEvent: "browser_steward.blocked_credential_exposure",
    });
    expect(JSON.stringify(redacted)).not.toContain("raw-reset-token-123456");
    expect(JSON.stringify(decision)).not.toContain("raw-reset-token-123456");
  });

  it("redacts OAuth bearer tokens embedded in URL fragments", () => {
    const rawUrl =
      "https://app.example/callback#access_token=raw-fragment-token-123456&id_token=raw-id-token";
    const redacted = redactBrowserStewardCredentialMaterial({ url: rawUrl });
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "navigate",
      request: { url: rawUrl },
    });

    expect(redacted).toEqual({ url: "REDACTED" });
    expect(decision).toMatchObject({
      credentialExposureKind: "credential_material",
      approvalRequired: true,
    });
    expect(JSON.stringify(decision)).not.toContain("raw-fragment-token-123456");
  });

  it("redacts every upload path while classifying credential-like filenames", () => {
    const rawPaths = ["/tmp/private-key.pem", "/tmp/report.pdf"];
    const redacted = redactBrowserStewardCredentialMaterial({
      action: "upload",
      paths: rawPaths,
    });

    expect(redacted).toEqual({ action: "upload", paths: ["REDACTED", "REDACTED"] });
    expect(JSON.stringify(redacted)).not.toContain("private-key.pem");
    expect(JSON.stringify(redacted)).not.toContain("report.pdf");

    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "upload",
      agentSessionKey: "agent:browser-session-credential-steward:runtime-check",
      request: { action: "upload", paths: rawPaths },
    });
    expect(decision).toMatchObject({
      approvalRequired: true,
      credentialExposureKind: "credential_material",
      telemetryEvent: "browser_steward.blocked_credential_exposure",
    });
    expect(JSON.stringify(decision)).not.toContain("private-key.pem");
    expect(JSON.stringify(decision)).not.toContain("report.pdf");
  });

  it("treats wait functions as credential-bearing executable material", () => {
    const rawFunction = "() => document.cookie && true";
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "act",
      agentSessionKey: "agent:browser-session-credential-steward:runtime-check",
      request: { kind: "wait", fn: rawFunction, targetId: "tab-1" },
    });

    expect(decision).toMatchObject({
      credentialExposureKind: "credential_material",
      approvalRequired: true,
      telemetryEvent: "browser_steward.blocked_credential_exposure",
    });
    expect(
      redactBrowserStewardCredentialMaterial({
        kind: "wait",
        fn: rawFunction,
        targetId: "tab-1",
      }),
    ).toEqual({ kind: "wait", fn: "REDACTED", targetId: "tab-1" });
    expect(JSON.stringify(decision)).not.toContain(rawFunction);
  });

  it("treats opaque select values as credential-bearing material", () => {
    const rawValue = "correct-horse-battery-staple";
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "act",
      agentSessionKey: "agent:browser-session-credential-steward:runtime-check",
      request: { kind: "select", targetId: "tab-1", values: [rawValue] },
    });

    expect(decision).toMatchObject({
      credentialExposureKind: "credential_material",
      approvalRequired: true,
      telemetryEvent: "browser_steward.blocked_credential_exposure",
    });
    const redacted = redactBrowserStewardCredentialMaterial({
      kind: "select",
      targetId: "tab-1",
      values: [rawValue],
    });
    expect(redacted).toEqual({ kind: "select", targetId: "tab-1", values: ["REDACTED"] });
    expect(JSON.stringify(decision)).not.toContain(rawValue);
    expect(JSON.stringify(redacted)).not.toContain(rawValue);
  });

  it("preserves fill field structure while redacting every opaque field value", () => {
    const rawEmail = "person@example.com";
    const rawPassword = "raw-fill-password-123456";
    const redacted = redactBrowserStewardCredentialMaterial({
      action: "act",
      request: {
        kind: "fill",
        fields: [
          { ref: "email", type: "text", value: rawEmail },
          { ref: "password", type: "password", value: rawPassword },
        ],
      },
    });

    expect(redacted).toEqual({
      action: "act",
      request: {
        kind: "fill",
        fields: [
          { ref: "email", type: "text", value: "REDACTED" },
          { ref: "password", type: "password", value: "REDACTED" },
        ],
      },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(rawEmail);
    expect(serialized).not.toContain(rawPassword);
  });

  it("never captures opaque browser output in runtime decisions", () => {
    const rawSecret = "correct-horse-battery-staple";
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "snapshot",
      request: { result: rawSecret },
    });

    expect(JSON.stringify(decision)).not.toContain(rawSecret);
  });

  it.each(credentialFixtures)("matches shared credential fixture: $name", (fixture) => {
    const decision = evaluateBrowserStewardRuntimeGuard({
      action: "status",
      request: {
        ...(fixture.labels ? { labels: fixture.labels } : {}),
        value: fixture.valueParts?.join("") ?? fixture.value,
      },
    });

    expect(decision).toMatchObject({
      credentialExposureKind: fixture.expected.exposureKind,
      credentialExposureReasonCode: fixture.expected.reasonCode,
      dataSensitivity: fixture.expected.blocked ? "critical" : "low",
      approvalRequired: fixture.expected.blocked,
      telemetryEvent: fixture.expected.blocked
        ? "browser_steward.blocked_credential_exposure"
        : "browser_steward.boundary_decision",
    });
    expect(decision.credentialClassesInvolved).toEqual([
      "browser session",
      ...fixture.expected.credentialClassesInvolved,
    ]);
    for (const rawValue of fixture.rawMustNotContain ?? []) {
      expect(JSON.stringify(decision)).not.toContain(rawValue);
      expect(
        JSON.stringify(
          redactBrowserStewardCredentialMaterial({
            ...(fixture.labels ? { labels: fixture.labels } : {}),
            value: fixture.valueParts?.join("") ?? fixture.value,
          }),
        ),
      ).not.toContain(rawValue);
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../audit/execution-identity-admission.js";
import { attachAgentCommandAdmissionFacts } from "./agent-command-admission-facts.js";
import {
  prepareAgentCommandExecutionIdentity,
  sanitizePublicAgentCommandIngressOpts,
} from "./agent-command-execution-identity.js";
import type { AgentCommandIngressOpts } from "./command/types.js";

let cleanupSink: (() => void) | undefined;

afterEach(() => {
  cleanupSink?.();
  cleanupSink = undefined;
});

describe("sanitizePublicAgentCommandIngressOpts", () => {
  it("removes a forged cron creator authority capability from plain-JavaScript ingress", () => {
    const forgedCapability = {
      active: true,
      runId: "forged-run",
      signal: new AbortController().signal,
      grantTokens: new Set<string>(),
      abort: () => undefined,
    };
    const opts = {
      prompt: "create an automation",
      cronCreatorAuthorityCapability: forgedCapability,
    } as unknown as AgentCommandIngressOpts;

    expect(sanitizePublicAgentCommandIngressOpts(opts)).toMatchObject({
      prompt: "create an automation",
      cronCreatorAuthorityCapability: undefined,
    });
  });
});

describe("Gateway agent command execution identity", () => {
  it("carries only the prepared bounded, redacted label into opt-in run admission", async () => {
    let work: ExecutionIdentityAdmissionWork | undefined;
    const displayLabel = "Operator OPENAI_API_KEY=***".padEnd(128, "x");
    cleanupSink = configureExecutionIdentityAdmissionSink((candidate) => {
      work = candidate;
      return true;
    });

    const opts: AgentCommandIngressOpts = {
      message: "attribute this run",
      allowModelOverride: false,
    };
    attachAgentCommandAdmissionFacts(opts, {
      ingress: {
        kind: "gateway-client",
        boundary: "gateway.ws.authenticated-connect",
        state: "present",
        rawSourceRef: "profile-ada",
      },
      invoker: {
        state: "present",
        kind: "person",
        rawPrincipalRef: "profile-ada",
        displayLabel,
      },
      assurance: [
        {
          kind: "durable-profile",
          rawEvidenceRef: "profile-ada",
          strength: "boundary-verified",
        },
      ],
    });
    const prepared = prepareAgentCommandExecutionIdentity({
      opts,
      prepared: {
        cfg: { logging: { audit: { enabled: true, executionIdentity: true } } },
        runId: "run-profiled",
        sessionAgentId: "main",
        sessionId: "session-profiled",
      },
      ingress: { kind: "api", boundary: "agent-command.from-ingress", state: "unknown" },
      lifecycleGeneration: "generation-1",
    });

    await prepared.admit("embedded");

    expect(work).toMatchObject({
      kind: "capture",
      envelope: {
        ingress: {
          kind: "gateway-client",
          boundary: "gateway.ws.authenticated-connect",
          state: "present",
        },
        invoker: {
          state: "present",
          kind: "person",
          rawPrincipalRef: "profile-ada",
          displayLabel: "Operator OPENAI_API_KEY=***",
        },
        assurance: [
          {
            kind: "durable-profile",
            rawEvidenceRef: "profile-ada",
            strength: "boundary-verified",
          },
        ],
      },
    });
    if (work?.kind !== "capture" || work.envelope.invoker?.state !== "present") {
      throw new Error("expected captured present invoker");
    }
    expect(work.envelope.invoker.displayLabel).toBe("Operator OPENAI_API_KEY=***");
    expect(work.envelope.invoker.displayLabel?.length).toBeLessThanOrEqual(128);
  });

  it("does not offer the prepared profile label to storage without execution audit opt-in", async () => {
    let work: ExecutionIdentityAdmissionWork | undefined;
    cleanupSink = configureExecutionIdentityAdmissionSink((candidate) => {
      work = candidate;
      return true;
    });

    const opts: AgentCommandIngressOpts = {
      message: "do not retain this label",
      allowModelOverride: false,
    };
    attachAgentCommandAdmissionFacts(opts, {
      ingress: {
        kind: "gateway-client",
        boundary: "gateway.ws.authenticated-connect",
        state: "present",
      },
      invoker: {
        state: "present",
        kind: "person",
        rawPrincipalRef: "profile-ada",
        displayLabel: "Ada",
      },
    });
    const prepared = prepareAgentCommandExecutionIdentity({
      opts,
      prepared: {
        cfg: { logging: { audit: { enabled: true, executionIdentity: false } } },
        runId: "run-profiled-disabled",
        sessionAgentId: "main",
        sessionId: "session-profiled-disabled",
      },
      ingress: { kind: "api", boundary: "agent-command.from-ingress", state: "unknown" },
      lifecycleGeneration: "generation-1",
    });

    await prepared.admit("embedded");

    expect(work).toBeUndefined();
  });
});

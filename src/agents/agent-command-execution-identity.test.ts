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
  it("carries the authenticated connection facts into run admission", async () => {
    let work: ExecutionIdentityAdmissionWork | undefined;
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
        displayLabel: "Ada",
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
          displayLabel: "Ada",
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
  });
});

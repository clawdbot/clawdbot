import { afterEach, describe, expect, it } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../audit/execution-identity-admission.js";
import { attachAgentCommandAdmissionFacts } from "./agent-command-admission-facts.js";
import {
  readAgentCommandExecutionIdentitySpawnFacts,
  withAgentCommandExecutionIdentitySpawnFacts,
} from "./agent-command-execution-identity-spawn.js";
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
  it("runs owner binding only after the awaited admission callback settles", async () => {
    const events: string[] = [];
    const prepared = prepareAgentCommandExecutionIdentity({
      opts: {
        message: "bind after admission",
        onAdmittedRunContext: async () => {
          await Promise.resolve();
          events.push("admitted");
        },
        onPostAdmittedRunContext: () => {
          events.push("owner-bound");
        },
      },
      prepared: {
        cfg: { logging: { audit: { enabled: true, executionIdentity: true } } },
        runId: "run-post-admission",
        sessionAgentId: "main",
        sessionId: "session-post-admission",
      },
      ingress: { kind: "api", boundary: "agent-command.from-ingress", state: "unknown" },
      lifecycleGeneration: "generation-1",
    });

    const admitted = await prepared.admit("embedded");
    await prepared.admit("embedded");

    expect(admitted.executionIdentityToken).toBeDefined();
    expect(events).toEqual(["admitted", "owner-bound"]);
  });

  it("preserves trusted spawn facts across internal option preparation", () => {
    const facts = {
      ingress: {
        kind: "api" as const,
        boundary: "sessions_spawn.subagent",
        state: "present" as const,
      },
      invoker: { state: "present" as const, kind: "agent" as const, rawPrincipalRef: "main" },
      applicableGrants: [{ rawGrantRef: "tool:sessions_spawn", state: "present" as const }],
      assurance: [],
      spawnAdmission: "[null,[]]",
    };
    const prepared = {
      ...withAgentCommandExecutionIdentitySpawnFacts(
        { message: "spawn", allowModelOverride: false },
        facts,
      ),
      lifecycleGeneration: "generation-1",
    };

    expect(readAgentCommandExecutionIdentitySpawnFacts(prepared)).toBe(facts);
  });

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

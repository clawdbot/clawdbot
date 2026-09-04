import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../audit/execution-identity-admission.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { attachAgentCommandAdmissionFacts } from "./agent-command-admission-facts.js";
import {
  readAgentCommandExecutionIdentitySpawnFacts,
  withAgentCommandExecutionIdentitySpawnFacts,
} from "./agent-command-execution-identity-spawn.js";
import {
  prepareAgentCommandExecutionIdentity,
  sanitizePublicAgentCommandIngressOpts,
} from "./agent-command-execution-identity.js";
import { createAgentAttemptLifecycleCallbacks } from "./command/attempt-callbacks.js";
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
  it.each(
    [false, true].flatMap((audit) =>
      [
        "started",
        "startup-failed",
        "closed-before-admission",
        "closed-before-start",
        "stale-attempt",
      ].map((outcome) => ({ audit, outcome })),
    ),
  )("registers a real recovery turn without a foreground lease: %j", async ({ audit, outcome }) => {
    const stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-admission-")),
    );
    const admittedCallback = createDeferred();
    const releaseCallback = createDeferred();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionEntry = {
      sessionId: "recovery-session",
      updatedAt: 100,
      status: "running" as const,
      abortedLastRun: false,
      lifecycleRunId: "recovery-run",
      restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration }],
      mainRestartRecovery: { cycleId: "recovery-cycle", revision: 4, chargedAttempts: 3 },
    };
    cleanupSink = configureExecutionIdentityAdmissionSink(() => true);
    let prepared: ReturnType<typeof prepareAgentCommandExecutionIdentity> | undefined;
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
        prepared = prepareAgentCommandExecutionIdentity({
          opts: {
            message: "continue interrupted work",
            mainRestartRecoveryAdmitted: true,
            mainRestartRecoveryAttempt: 3,
            onAdmittedRunContext: async () => {
              admittedCallback.resolve();
              await releaseCallback.promise;
            },
          },
          prepared: {
            cfg: { logging: { audit: { enabled: audit, executionIdentity: audit } } },
            runId: "recovery-run",
            sessionAgentId: "main",
            sessionId: sessionEntry.sessionId,
            sessionKey,
            storePath,
            sessionEntry,
          },
          ingress: { kind: "system", boundary: "restart-recovery", state: "present" },
          lifecycleGeneration,
        });
        const callbacks = createAgentAttemptLifecycleCallbacks(
          {
            currentTurnUserMessagePersisted: false,
            lifecycleFinishing: false,
            lifecycleEnded: false,
          },
          prepared.onRuntimeTurnStarted,
        );
        const admission = prepared.admit("embedded");
        const settled = admission.catch(() => undefined);
        await admittedCallback.promise;
        expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
          mainRestartRecovery: { chargedAttempts: 3 },
        });
        expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
          "mainRestartRecovery.startedAttempt",
        );
        if (outcome === "closed-before-admission") {
          prepared.close();
        }
        releaseCallback.resolve();
        await settled;
        if (outcome === "closed-before-admission") {
          await expect(admission).rejects.toThrow("closed during admission");
          await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
          expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
            mainRestartRecovery: sessionEntry.mainRestartRecovery,
          });
          expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
            "mainRestartRecovery.startedAttempt",
          );
          return;
        }
        const context = await admission;
        await expect(prepared.admit("embedded")).resolves.toBe(context);
        // A selected/authenticated runtime can still stall before turn/start.
        expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
          "mainRestartRecovery.startedAttempt",
        );
        if (audit) {
          expect(loadSessionEntry({ sessionKey, storePath })).toHaveProperty(
            "mainRestartRecovery.executionIdentity",
            context.executionIdentityToken,
          );
        }
        if (outcome === "closed-before-start") {
          prepared.close();
        } else if (outcome === "stale-attempt") {
          await replaceSessionEntry(
            { sessionKey, storePath },
            {
              ...sessionEntry,
              mainRestartRecovery: { ...sessionEntry.mainRestartRecovery, chargedAttempts: 4 },
            },
          );
        }
        await callbacks.onAgentEvent({
          stream: "lifecycle",
          data: {
            phase: outcome === "startup-failed" ? "error" : "start",
          },
        });
        if (outcome !== "started") {
          expect(loadSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
            "mainRestartRecovery.startedAttempt",
          );
          return;
        }
        await callbacks.onAgentEvent({ stream: "lifecycle", data: { phase: "start" } });
        expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
          mainRestartRecovery: {
            chargedAttempts: 3,
            startedAttempt: 3,
            ...(audit ? { executionIdentity: context.executionIdentityToken } : {}),
          },
        });
      });
    } finally {
      prepared?.close();
      releaseCallback.resolve();
      closeOpenClawAgentDatabasesForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

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

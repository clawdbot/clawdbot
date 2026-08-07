import { afterEach, describe, expect, it } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../audit/execution-identity-admission.js";
import {
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  resetAgentRunRegistryForTest,
} from "../infra/agent-run-registry.js";
import { executionIdentity } from "./agent-command-execution-identity.js";
import { createAgentExecutionAttribution } from "./agent-execution-attribution.js";

describe("agent command execution identity", () => {
  let restoreSink: (() => void) | undefined;

  afterEach(() => {
    restoreSink?.();
    restoreSink = undefined;
    resetAgentRunRegistryForTest();
  });

  it("records the runtime correlation without requiring an audit admission token", () => {
    const work: ExecutionIdentityAdmissionWork[] = [];
    restoreSink = configureExecutionIdentityAdmissionSink((item) => {
      work.push(item);
      return true;
    });
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });

    executionIdentity.record({
      attribution,
      agentId: "main",
      cfg: { logging: { audit: { enabled: true, executionIdentity: true } } },
      ingress: executionIdentity.localIngress,
      runId: attribution.runId,
      runtimeKind: "embedded",
    });

    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      kind: "capture",
      envelope: {
        contextId: attribution.contextId,
        executionId: attribution.executionId,
        createdAt: attribution.createdAt,
      },
    });
    expect(attribution).not.toHaveProperty("executionIdentityAdmission");
  });

  it("uses exact attribution as the lifecycle authority", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-attribution",
    });

    expect(
      executionIdentity.resolveAttribution(
        {
          executionAttribution: attribution,
          lifecycleGeneration: "generation-flat",
        } as never,
        { runId: attribution.runId },
      ),
    ).toEqual({
      attribution,
      lifecycleGeneration: "generation-attribution",
    });
  });

  it("rejects attribution captured for a different run", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-attribution",
      lifecycleGeneration: "generation-attribution",
    });

    expect(() =>
      executionIdentity.resolveAttribution(
        {
          executionAttribution: attribution,
        } as never,
        { runId: "run-command" },
      ),
    ).toThrow("Agent command execution attribution runId does not match the command runId.");
  });

  it("allocates private attribution for direct command admission", () => {
    const resolved = executionIdentity.resolveAttribution(
      { lifecycleGeneration: "generation-local" } as never,
      {
        runId: "run-local",
        sessionKey: "agent:main:local",
        sessionId: "session-local",
        sessionAgentId: "main",
      },
    );

    expect(resolved.attribution).toMatchObject({
      runId: "run-local",
      lifecycleGeneration: "generation-local",
      sessionKey: "agent:main:local",
      sessionId: "session-local",
      agentId: "main",
    });
    expect(resolved.attribution).not.toHaveProperty("executionIdentityAdmission");
  });

  it("atomically reserves one attribution for concurrent cross-session admission", () => {
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    const runId = "run-shared";
    const first = executionIdentity.resolveAttribution({ lifecycleGeneration } as never, {
      runId,
      sessionKey: "agent:main:first-session",
      sessionId: "first-session",
      sessionAgentId: "main",
    });

    expect(getAgentRunContext(runId)?.attribution).toBe(first.attribution);
    expect(() =>
      executionIdentity.resolveAttribution({ lifecycleGeneration } as never, {
        runId,
        sessionKey: "agent:main:second-session",
        sessionId: "second-session",
        sessionAgentId: "main",
      }),
    ).toThrow("Agent run ID is already bound to different execution attribution.");
    expect(getAgentRunContext(runId)?.attribution).toBe(first.attribution);
  });

  it("replaces attribution only after lifecycle rebound", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });
    const opts = { executionAttribution: attribution } as never;

    expect(executionIdentity.replaceAttribution(opts, attribution)).toBe(opts);
    expect(
      executionIdentity.replaceAttribution(
        opts,
        createAgentExecutionAttribution({
          ...attribution,
          lifecycleGeneration: "generation-2",
        }),
      ),
    ).not.toBe(opts);
  });

  it("strips untrusted ingress attribution and preserves trusted gateway attribution", () => {
    const attribution = createAgentExecutionAttribution({
      runId: "run-1",
      lifecycleGeneration: "generation-1",
    });
    const opts = {
      allowModelOverride: false,
      executionAttribution: attribution,
      lifecycleGeneration: "generation-flat",
      runId: attribution.runId,
    } as never;

    expect(executionIdentity.prepareIngress(opts, false)).toEqual({
      lifecycleGeneration: "generation-flat",
      opts: {
        allowModelOverride: false,
        executionAttribution: undefined,
        lifecycleGeneration: "generation-flat",
        runId: attribution.runId,
      },
    });
    expect(executionIdentity.prepareIngress(opts, true)).toEqual({
      lifecycleGeneration: "generation-flat",
      opts,
    });

    const inheritedOpts = Object.assign(Object.create({ executionAttribution: attribution }), {
      allowModelOverride: false,
      lifecycleGeneration: "generation-flat",
      runId: attribution.runId,
    }) as never;
    expect(executionIdentity.prepareIngress(inheritedOpts, false).opts).toHaveProperty(
      "executionAttribution",
      undefined,
    );
  });
});

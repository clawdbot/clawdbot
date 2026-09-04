import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import {
  consumeCronCreatorAuthorityGrant,
  createCronCreatorAuthorityRunScope,
  getCronManagementAuthority,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
  withCronManagementGrant,
} from "./cron-creator-authority-grant.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetAgentRunRegistryForTest();
});

function createManagementFixture(controlUiAdmin = true) {
  const runId = "run-admin-management";
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const scope = createCronCreatorAuthorityRunScope(
    runId,
    { kind: "local" },
    controlUiAdmin ? true : undefined,
  );
  const operation = new AbortController();
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:control-ui",
    operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority },
  };
  onTestFinished(() => revokeCronCreatorAuthorityRunScope(scope));
  return {
    authority,
    identity,
    scope,
    operation,
    mint: (method = "cron.get") =>
      mintCronCreatorAuthorityGrant(scope, operation.signal, undefined, { method, authority }),
  };
}

describe("cron creator authority grants", () => {
  it("consumes an exact live grant only once", () => {
    const scope = createCronCreatorAuthorityRunScope("run-1");
    const grant = mintCronCreatorAuthorityGrant(scope);

    expect(() => consumeCronCreatorAuthorityGrant(grant)).not.toThrow();
    expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
    revokeCronCreatorAuthorityRunScope(scope);
  });

  it("rejects a runId mismatch without consuming the exact grant", () => {
    const scope = createCronCreatorAuthorityRunScope("run-1");
    const grant = mintCronCreatorAuthorityGrant(scope);

    expect(() => consumeCronCreatorAuthorityGrant({ ...grant, runId: "run-other" })).toThrow(
      "Configured MCP cron authority is no longer active",
    );
    expect(() => consumeCronCreatorAuthorityGrant(grant)).not.toThrow();
    revokeCronCreatorAuthorityRunScope(scope);
  });

  it("rejects grants revoked by run settlement or abort", () => {
    const scope = createCronCreatorAuthorityRunScope("run-1");
    const grant = mintCronCreatorAuthorityGrant(scope);
    revokeCronCreatorAuthorityRunScope(scope);

    expect(scope.signal.aborted).toBe(true);
    expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
  });

  it("rejects a grant when its exact tool operation aborts", () => {
    const scope = createCronCreatorAuthorityRunScope("run-1");
    const operation = new AbortController();
    const grant = mintCronCreatorAuthorityGrant(scope, operation.signal);

    operation.abort(new Error("tool call timed out"));

    expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
    revokeCronCreatorAuthorityRunScope(scope);
  });

  it("cleans operation abort listeners after consume and run revocation", () => {
    const consumedScope = createCronCreatorAuthorityRunScope("run-consume");
    const consumedOperation = new AbortController();
    const consumedRemove = vi.spyOn(consumedOperation.signal, "removeEventListener");
    const consumedGrant = mintCronCreatorAuthorityGrant(consumedScope, consumedOperation.signal);

    consumeCronCreatorAuthorityGrant(consumedGrant);
    expect(consumedRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    revokeCronCreatorAuthorityRunScope(consumedScope);

    const revokedScope = createCronCreatorAuthorityRunScope("run-revoke");
    const revokedOperation = new AbortController();
    const revokedRemove = vi.spyOn(revokedOperation.signal, "removeEventListener");
    mintCronCreatorAuthorityGrant(revokedScope, revokedOperation.signal);

    revokeCronCreatorAuthorityRunScope(revokedScope);
    expect(revokedRemove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("transports a private immutable runtime authority only through one-shot consumption", () => {
    const scope = createCronCreatorAuthorityRunScope("run-authority");
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };

    const grant = mintCronCreatorAuthorityGrant(scope, undefined, runtimeAuthority);

    expect(grant).toEqual({ runId: "run-authority", token: expect.any(String) });
    expect(consumeCronCreatorAuthorityGrant(grant)).toEqual(runtimeAuthority);
    expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
    revokeCronCreatorAuthorityRunScope(scope);
  });
});

describe("cron management authority grants", () => {
  const denied = /Retry from a fresh authenticated Control UI administrator turn/;

  it("retains a redeemed queued operation until its exact run closes, without permitting replay", async () => {
    const fixture = createManagementFixture();
    const grant = fixture.mint();
    let retained: (() => void) | undefined;
    await withCronManagementGrant(grant, fixture.identity, "cron.get", async () => {
      retained = getCronManagementAuthority(fixture.identity);
      expect(retained).toBeTypeOf("function");
      expect(getCronManagementAuthority({ ...fixture.identity })).toBeUndefined();
      retained!();
      await Promise.resolve();
      retained!();
    });
    expect(getCronManagementAuthority(fixture.identity)).toBeUndefined();
    expect(retained).not.toThrow();
    revokeCronCreatorAuthorityRunScope(fixture.scope);
    expect(retained).toThrow(denied);
    const replay = vi.fn();
    await expect(
      withCronManagementGrant(grant, fixture.identity, "cron.get", replay),
    ).rejects.toThrow(denied);
    expect(replay).not.toHaveBeenCalled();
  });

  it("rejects missing grants and callers without an admitted admin capability", async () => {
    const fixture = createManagementFixture(false);
    const run = vi.fn();
    expect(fixture.mint).toThrow(denied);
    await expect(
      withCronManagementGrant(
        { runId: fixture.scope.runId, token: "missing-grant" },
        fixture.identity,
        "cron.get",
        run,
      ),
    ).rejects.toThrow(denied);
    expect(run).not.toHaveBeenCalled();
  });

  it("expires at sixty seconds before redemption", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fixture = createManagementFixture();
    const grant = fixture.mint();
    clock.mockReturnValue(61_000);
    const run = vi.fn();
    await expect(withCronManagementGrant(grant, fixture.identity, "cron.get", run)).rejects.toThrow(
      denied,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["method", "run", "instance", "lifecycle", "claim"] as const)(
    "rejects %s substitution without spending the original grant",
    async (substitution) => {
      const fixture = createManagementFixture();
      const grant = fixture.mint();
      const identity: AgentRuntimeIdentity = {
        ...fixture.identity,
        operationalRunInstance: {
          ...fixture.identity.operationalRunInstance,
          ...(substitution === "instance" ? { instanceId: "other-instance" } : {}),
        },
        delegatedAuthority: {
          ...fixture.identity.delegatedAuthority,
          ...(substitution === "lifecycle" ? { lifecycleGeneration: "other-lifecycle" } : {}),
          ...(substitution === "claim" ? { claimId: "other-claim" } : {}),
        },
      };
      const run = vi.fn();
      await expect(
        withCronManagementGrant(
          substitution === "run" ? { ...grant, runId: "other-run" } : grant,
          identity,
          substitution === "method" ? "cron.remove" : "cron.get",
          run,
        ),
      ).rejects.toThrow(denied);
      expect(run).not.toHaveBeenCalled();
      await expect(
        withCronManagementGrant(grant, fixture.identity, "cron.get", async () => "allowed"),
      ).resolves.toBe("allowed");
    },
  );

  it("keeps creator and management grants purpose-bound", async () => {
    const fixture = createManagementFixture();
    const creator = mintCronCreatorAuthorityGrant(fixture.scope);
    await expect(
      withCronManagementGrant(creator, fixture.identity, "cron.get", vi.fn()),
    ).rejects.toThrow(denied);
    expect(() => consumeCronCreatorAuthorityGrant(creator)).not.toThrow();
    expect(() => fixture.mint("cron.add")).toThrow(denied);

    const management = fixture.mint();
    expect(() => consumeCronCreatorAuthorityGrant(management)).toThrow(
      "Configured MCP cron authority is no longer active",
    );
    await expect(
      withCronManagementGrant(management, fixture.identity, "cron.get", async () => "allowed"),
    ).resolves.toBe("allowed");
  });

  it.each([
    [
      "release",
      (fixture: ReturnType<typeof createManagementFixture>) =>
        releaseAgentRunDelegatedAuthority(fixture.authority),
    ],
    [
      "replacement",
      (fixture: ReturnType<typeof createManagementFixture>) =>
        claimAgentRunDelegatedAuthority(
          createTestAdmittedRunContext(fixture.scope.runId).operationalRunInstance,
        ),
    ],
    ["lifecycle rotation", () => rotateAgentRunRegistryLifecycleGeneration()],
    [
      "scope revocation",
      (fixture: ReturnType<typeof createManagementFixture>) =>
        revokeCronCreatorAuthorityRunScope(fixture.scope),
    ],
    ["scope abort", (fixture: ReturnType<typeof createManagementFixture>) => fixture.scope.abort()],
    [
      "operation abort",
      (fixture: ReturnType<typeof createManagementFixture>) => fixture.operation.abort(),
    ],
    ["expiry", () => vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)],
  ] as const)("denies a suspended operation after %s", async (_label, invalidate) => {
    const fixture = createManagementFixture();
    const started = createDeferred();
    const resume = createDeferred();
    const effect = vi.fn();
    const operation = withCronManagementGrant(
      fixture.mint(),
      fixture.identity,
      "cron.get",
      async () => {
        const assertActive = getCronManagementAuthority(fixture.identity)!;
        assertActive();
        started.resolve();
        await resume.promise;
        assertActive();
        effect();
      },
    );
    const rejected = expect(operation).rejects.toThrow(denied);
    await started.promise;
    invalidate(fixture);
    resume.resolve();
    await rejected;
    expect(effect).not.toHaveBeenCalled();
  });
});

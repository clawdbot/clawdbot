import { describe, expect, it, vi } from "vitest";
import {
  consumeCronCreatorAuthorityGrant,
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "./cron-creator-authority-grant.js";

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

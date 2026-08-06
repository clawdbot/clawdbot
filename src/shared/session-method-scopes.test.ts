import { describe, expect, it } from "vitest";
import { resolveDynamicSessionMutationRequiredScope } from "./session-method-scopes.js";

describe("resolveDynamicSessionMutationRequiredScope", () => {
  it("keeps ordinary session creation write-scoped", () => {
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.create", {
        agentId: "main",
        message: "hello",
        worktree: true,
      }),
    ).toBe("operator.write");
  });

  it.each([
    { incognito: true },
    { key: "agent:main:dashboard:incognito-123" },
    { parentSessionKey: "agent:main:subagent:incognito-123" },
    { cwd: "/tmp/workspace" },
    { execNode: "node-1" },
  ])("requires admin for privileged session creation params %#", (params) => {
    expect(resolveDynamicSessionMutationRequiredScope("sessions.create", params)).toBe(
      "operator.admin",
    );
  });

  it("allows only organizational session patches with write scope", () => {
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.patch", {
        key: "agent:main:thread",
        label: "Renamed",
        archived: true,
      }),
    ).toBe("operator.write");
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.patch", {
        key: "agent:main:thread",
        thinkingLevel: "high",
      }),
    ).toBe("operator.admin");
  });

  it("allows write-scoped deletion only for safe archived-only requests", () => {
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.delete", {
        key: "agent:main:archived",
        deleteTranscript: true,
        archivedOnly: true,
      }),
    ).toBe("operator.write");
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.delete", {
        key: "agent:main:active",
        deleteTranscript: true,
      }),
    ).toBe("operator.admin");
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.delete", {
        key: "agent:main:archived",
        archivedOnly: true,
        emitLifecycleHooks: false,
      }),
    ).toBe("operator.admin");
  });

  it("does not duplicate static method policy from the core descriptor table", () => {
    expect(resolveDynamicSessionMutationRequiredScope("sessions.groups.put")).toBeUndefined();
    expect(resolveDynamicSessionMutationRequiredScope("sessions.list")).toBeUndefined();
  });
});

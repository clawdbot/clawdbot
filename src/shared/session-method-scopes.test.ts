import { describe, expect, it } from "vitest";
import { resolveDynamicSessionMutationRequiredScope } from "./session-method-scopes.js";

describe("resolveDynamicSessionMutationRequiredScope", () => {
  it("keeps explicit restart recovery at write scope", () => {
    expect(resolveDynamicSessionMutationRequiredScope("sessions.recover")).toBe("operator.write");
  });

  it.each([
    { agentId: "main", message: "hello", worktree: true },
    { agentId: "main", message: "hello", projectId: "openclaw" },
  ])("keeps ordinary session creation write-scoped %#", (params) => {
    expect(resolveDynamicSessionMutationRequiredScope("sessions.create", params)).toBe(
      "operator.write",
    );
  });

  it.each([
    { incognito: true },
    { key: "agent:main:dashboard:incognito-123" },
    { parentSessionKey: "agent:main:subagent:incognito-123" },
    { execNode: "node-1" },
  ])("requires admin for privileged session creation params %#", (params) => {
    expect(resolveDynamicSessionMutationRequiredScope("sessions.create", params)).toBe(
      "operator.admin",
    );
  });

  it("leaves Gateway cwd containment to the state-aware create handler", () => {
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.create", {
        cwd: "/configured/workspace/packages/app",
      }),
    ).toBe("operator.write");
  });

  it.each([
    { name: "model set", patch: { model: "openai/gpt-5.6-luna" } },
    { name: "model reset", patch: { model: null } },
    { name: "icon set", patch: { icon: "🦞" } },
    { name: "icon reset", patch: { icon: null } },
    {
      name: "safe mixed patch",
      patch: { label: "Renamed", archived: true, model: "openai/gpt-5.6-luna" },
    },
    {
      name: "CAS envelope",
      patch: { expectedSessionId: "session-1", expectedLifecycleRevision: "revision-1" },
    },
  ])("keeps $name write-scoped", ({ patch }) => {
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.patch", {
        key: "agent:main:thread",
        agentId: "main",
        ...patch,
      }),
    ).toBe("operator.write");
  });

  it.each([
    { thinkingLevel: "high" },
    { fastMode: true },
    { verboseLevel: "full" },
    { reasoningLevel: "high" },
    { model: "openai/gpt-5.6-luna", thinkingLevel: "high" },
    { model: null, futureField: true },
  ])("keeps privileged or unknown patch fields admin-scoped %#", (patch) => {
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.patch", {
        key: "agent:main:thread",
        ...patch,
      }),
    ).toBe("operator.admin");
  });

  it("scopes sessions.patchMany from the shared patch only", () => {
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.patchMany", {
        targets: [
          {
            key: "agent:main:thread",
            agentId: "main",
            expectedSessionId: "session-1",
            expectedLifecycleRevision: "revision-1",
          },
        ],
        patch: {
          label: "Renamed",
          icon: "🦞",
          archived: true,
          unread: false,
          model: "openai/gpt-5.6-luna",
        },
      }),
    ).toBe("operator.write");
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.patchMany", {
        targets: [{ key: "agent:main:thread" }],
        patch: { model: null },
      }),
    ).toBe("operator.write");
    for (const patch of [
      { statusNote: "Working" },
      { thinkingLevel: "high" },
      { model: "openai/gpt-5.6-luna", fastMode: true },
      { futureField: true },
    ]) {
      expect(
        resolveDynamicSessionMutationRequiredScope("sessions.patchMany", {
          targets: [{ key: "agent:main:thread" }],
          patch,
        }),
      ).toBe("operator.admin");
    }
    expect(resolveDynamicSessionMutationRequiredScope("sessions.patchMany")).toBe("operator.write");
    expect(resolveDynamicSessionMutationRequiredScope("sessions.patchMany", {})).toBe(
      "operator.write",
    );
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

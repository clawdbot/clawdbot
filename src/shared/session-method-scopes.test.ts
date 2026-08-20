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

  it.each(["read-only", "guarded", "workspace"])(
    "keeps sessions.create permission mode %s write-scoped",
    (permissionMode) => {
      expect(
        resolveDynamicSessionMutationRequiredScope("sessions.create", { permissionMode }),
      ).toBe("operator.write");
    },
  );

  it("requires admin to create a full-access session", () => {
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.create", { permissionMode: "full" }),
    ).toBe("operator.admin");
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

  it.each(["read-only", "guarded", "workspace"])(
    "keeps sessions.patch permission mode %s write-scoped",
    (permissionMode) => {
      expect(
        resolveDynamicSessionMutationRequiredScope("sessions.patch", {
          key: "agent:main:thread",
          permissionMode,
        }),
      ).toBe("operator.write");
    },
  );

  it("requires admin to patch a session to full access", () => {
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.patch", {
        key: "agent:main:thread",
        permissionMode: "full",
      }),
    ).toBe("operator.admin");
    expect(
      resolveDynamicSessionMutationRequiredScope("sessions.patchMany", {
        targets: [{ key: "agent:main:thread" }],
        patch: { permissionMode: "full" },
      }),
    ).toBe("operator.admin");
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
        expectedSessionId: "session-1",
      }),
    ).toBe("operator.write");
    for (const params of [
      undefined,
      null,
      [],
      { key: "agent:main:active", deleteTranscript: true },
      { key: "agent:main:archived", archivedOnly: "yes" },
      {
        key: "agent:main:archived",
        archivedOnly: true,
        expectedSessionId: "session-1",
        emitLifecycleHooks: false,
      },
      {
        key: "agent:main:archived",
        archivedOnly: true,
        expectedSessionId: "session-1",
        futureField: true,
      },
    ]) {
      expect(resolveDynamicSessionMutationRequiredScope("sessions.delete", params)).toBe(
        "operator.admin",
      );
    }
  });

  it.each([
    [{ key: "agent:main:thread", profileId: "development" }, "operator.admin"],
    [{ key: "agent:main:thread", profileId: "   " }, "operator.admin"],
    [{ key: "agent:main:thread", deviceId: "device-1" }, "operator.write"],
    [
      { key: "agent:main:thread", profileId: "development", deviceId: "device-1" },
      "operator.write",
    ],
  ] as const)("classifies dispatch target %j as %s", (params, expected) => {
    expect(resolveDynamicSessionMutationRequiredScope("sessions.dispatch", params)).toBe(expected);
  });

  const moveExpected = {
    generation: 1,
    environmentId: "environment-1",
    ownerEpoch: 1,
  };
  it.each([
    [
      { key: "agent:main:thread", expected: moveExpected, target: { kind: "gateway" } },
      "operator.write",
    ],
    [
      {
        key: "agent:main:thread",
        expected: moveExpected,
        target: { kind: "device", deviceId: "device-1" },
      },
      "operator.write",
    ],
    [
      {
        key: "agent:main:thread",
        expected: moveExpected,
        target: { kind: "profile", profileId: "development" },
      },
      "operator.admin",
    ],
    [
      { key: "agent:main:thread", target: { kind: "profile", profileId: "development" } },
      "operator.write",
    ],
  ] as const)("classifies move target %j as %s", (params, expected) => {
    expect(resolveDynamicSessionMutationRequiredScope("sessions.move", params)).toBe(expected);
  });

  it("does not duplicate static method policy from the core descriptor table", () => {
    expect(resolveDynamicSessionMutationRequiredScope("sessions.groups.put")).toBeUndefined();
    expect(resolveDynamicSessionMutationRequiredScope("sessions.list")).toBeUndefined();
  });
});

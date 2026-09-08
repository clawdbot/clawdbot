import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getSessionEntry,
  patchSessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { clearCodexBindingAfterInvalidImagePayload } from "./src/app-server/run-attempt-state.js";
import {
  createCodexTestBindingStore,
  sessionBindingIdentity,
  type CodexAppServerThreadBinding,
} from "./src/app-server/session-binding.test-helpers.js";

const session = {
  agentId: "worker",
  sessionId: "session-one",
  sessionKey: "agent:worker:ownership",
};
const identity = sessionBindingIdentity(session);
const observedBinding: CodexAppServerThreadBinding = {
  threadId: "native-thread",
  cwd: "/synthetic-workspace",
  model: "native-model",
  modelProvider: "native-provider",
  authProfileId: "selected-profile",
};

function createOwnershipFixture() {
  const bindingStore = createCodexTestBindingStore();
  const harness = createCodexAppServerAgentHarness({ bindingStore });
  const resolveOwnership = harness.resolveSessionRuntimeOwnership?.bind(harness);
  if (!resolveOwnership) {
    throw new Error("expected Codex session runtime ownership capability");
  }
  return {
    bindingStore,
    harness,
    resolveOwnership: (overrides: Partial<Parameters<typeof resolveOwnership>[0]> = {}) =>
      resolveOwnership({ ...session, assertCurrent() {}, ...overrides }),
  };
}

describe("Codex session runtime ownership", () => {
  it.each<{
    name: string;
    binding?: CodexAppServerThreadBinding;
    expected?: {
      model: "native";
      auth: "native" | "host";
      modelRef?: { provider: string; model: string };
    };
  }>([
    { name: "missing binding" },
    { name: "ordinary binding with an observed native model", binding: observedBinding },
    {
      name: "native model ownership retaining host auth without supervision",
      binding: { ...observedBinding, preserveNativeModel: true },
      expected: {
        model: "native",
        auth: "host",
        modelRef: { provider: "native-provider", model: "native-model" },
      },
    },
    {
      name: "materialized supervision with a concrete native model",
      binding: {
        ...observedBinding,
        connectionScope: "supervision",
        supervisionSourceThreadId: "native-source",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
      },
      expected: {
        model: "native",
        auth: "native",
        modelRef: { provider: "native-provider", model: "native-model" },
      },
    },
    {
      name: "pending supervision without a model selection",
      binding: {
        threadId: "native-source",
        cwd: "/synthetic-workspace",
        connectionScope: "supervision",
        supervisionSourceThreadId: "native-source",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        pendingSupervisionBranch: { sourceThreadId: "native-source" },
      },
      expected: { model: "native", auth: "native" },
    },
  ])("classifies $name without changing its binding", async ({ binding, expected }) => {
    const fixture = createOwnershipFixture();
    if (binding) {
      await fixture.bindingStore.mutate(identity, { kind: "set", binding });
    }

    const readPreviousSessionId = vi.fn(() => undefined);
    expect(fixture.resolveOwnership({ readPreviousSessionId })).toEqual(expected);
    expect(readPreviousSessionId).toHaveBeenCalledTimes(binding ? 0 : 1);
    expect(fixture.bindingStore.read(identity)).toEqual(binding);
  });

  it.each([false, true])(
    "respects expected native ownership during image cleanup (%s)",
    async (expected) => {
      const fixture = createOwnershipFixture();
      const binding = { ...observedBinding, preserveNativeModel: true as const };
      await fixture.bindingStore.mutate(identity, { kind: "set", binding });

      await clearCodexBindingAfterInvalidImagePayload(
        fixture.bindingStore,
        identity,
        { phase: "turn_completed", threadId: binding.threadId, error: "synthetic invalid image" },
        expected ? { model: "native", auth: "host" } : undefined,
      );

      expect(fixture.bindingStore.read(identity)).toEqual(expected ? binding : undefined);
    },
  );

  it.each(["host", "native"] as const)(
    "reads %s auth ownership from the recorded predecessor without adopting it",
    async (auth) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ownership-predecessor-"));
      const storePath = path.join(root, "sessions.json");
      const scope = { agentId: session.agentId, sessionKey: session.sessionKey, storePath };
      const fixture = createOwnershipFixture();
      const successor = { ...identity, sessionId: "session-successor" };
      const binding: CodexAppServerThreadBinding = {
        ...observedBinding,
        preserveNativeModel: true,
        ...(auth === "native"
          ? {
              connectionScope: "supervision",
              supervisionSourceThreadId: "native-source",
              conversationSourceTransferComplete: true,
            }
          : {}),
      };
      try {
        await upsertSessionEntry({
          ...scope,
          entry: { sessionId: session.sessionId, updatedAt: 1 },
        });
        await fixture.bindingStore.mutate(identity, { kind: "set", binding });
        await patchSessionEntry({ ...scope, update: () => ({ sessionId: successor.sessionId }) });
        const readPreviousSessionId = () => {
          const entry = getSessionEntry({
            ...scope,
            hydrateSkillPromptRefs: false,
            readConsistency: "latest",
          });
          return entry?.sessionId === successor.sessionId ? entry.previousSessionId : undefined;
        };

        expect(
          fixture.resolveOwnership({
            sessionId: successor.sessionId,
            readPreviousSessionId,
            storePath,
            config: { session: { store: path.join(root, "other", "sessions.json") } },
          }),
        ).toEqual({
          model: "native",
          auth,
          modelRef: { provider: binding.modelProvider, model: binding.model },
        });
        expect(fixture.bindingStore.read(identity)).toEqual(binding);
        expect(fixture.bindingStore.read(successor)).toBeUndefined();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("does not claim a stale physical generation or reclaim its binding", async () => {
    const fixture = createOwnershipFixture();
    const binding = { ...observedBinding, preserveNativeModel: true as const };
    await fixture.bindingStore.mutate(identity, { kind: "set", binding });

    expect(fixture.resolveOwnership({ sessionId: "session-successor" })).toBeUndefined();
    expect(fixture.bindingStore.read(identity)).toEqual(binding);
  });

  it("does not reuse model ownership after binding retirement", async () => {
    const fixture = createOwnershipFixture();
    await fixture.bindingStore.mutate(identity, {
      kind: "set",
      binding: { ...observedBinding, preserveNativeModel: true },
    });
    expect(fixture.resolveOwnership()).toEqual({
      model: "native",
      auth: "host",
      modelRef: { provider: "native-provider", model: "native-model" },
    });
    await fixture.bindingStore.retireSessionGeneration(identity);

    expect(fixture.resolveOwnership()).toBeUndefined();
  });

  it.each(["revoked", "disposed"] as const)(
    "refuses %s admission before reading private state",
    async (reason) => {
      const fixture = createOwnershipFixture();
      const read = vi.spyOn(fixture.bindingStore, "read");
      if (reason === "disposed") {
        await fixture.harness.dispose?.();
      }
      const assertCurrent = () => {
        if (reason === "revoked") {
          throw new Error("admission revoked");
        }
      };

      expect(() => fixture.resolveOwnership({ assertCurrent })).toThrow(
        reason === "disposed" ? "harness is disposed" : "admission revoked",
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(["revoked", "disposed"] as const)(
    "rejects ownership when admission becomes %s during the binding read",
    async (reason) => {
      const fixture = createOwnershipFixture();
      await fixture.bindingStore.mutate(identity, {
        kind: "set",
        binding: { ...observedBinding, preserveNativeModel: true },
      });
      const readBinding = fixture.bindingStore.read.bind(fixture.bindingStore);
      let current = true;
      const cleanup: { disposal?: Promise<void> } = {};
      vi.spyOn(fixture.bindingStore, "read").mockImplementationOnce((requestedIdentity) => {
        const binding = readBinding(requestedIdentity);
        if (reason === "disposed") {
          const disposal = fixture.harness.dispose?.();
          if (disposal) {
            cleanup.disposal = disposal;
          }
        } else {
          current = false;
        }
        return binding;
      });
      try {
        expect(() =>
          fixture.resolveOwnership({
            assertCurrent() {
              if (!current) {
                throw new Error("admission revoked");
              }
            },
          }),
        ).toThrow(reason === "disposed" ? "harness is disposed" : "admission revoked");
      } finally {
        if (cleanup.disposal) {
          await cleanup.disposal;
        }
      }
    },
  );
});

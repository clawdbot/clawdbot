import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
    expected?: { model: "native"; auth: "native" | "host" };
  }>([
    { name: "missing binding" },
    { name: "ordinary binding with an observed native model", binding: observedBinding },
    {
      name: "native model ownership retaining host auth without supervision",
      binding: { ...observedBinding, preserveNativeModel: true },
      expected: { model: "native", auth: "host" },
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
      expected: { model: "native", auth: "native" },
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

    await expect(fixture.resolveOwnership()).resolves.toEqual(expected);
    await expect(fixture.bindingStore.read(identity)).resolves.toEqual(binding);
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

      await expect(fixture.bindingStore.read(identity)).resolves.toEqual(
        expected ? binding : undefined,
      );
    },
  );

  it("does not claim a stale physical generation or reclaim its binding", async () => {
    const fixture = createOwnershipFixture();
    const binding = { ...observedBinding, preserveNativeModel: true as const };
    await fixture.bindingStore.mutate(identity, { kind: "set", binding });

    await expect(
      fixture.resolveOwnership({ sessionId: "session-successor" }),
    ).resolves.toBeUndefined();
    await expect(fixture.bindingStore.read(identity)).resolves.toEqual(binding);
  });

  it("does not reuse model ownership after binding retirement", async () => {
    const fixture = createOwnershipFixture();
    await fixture.bindingStore.mutate(identity, {
      kind: "set",
      binding: { ...observedBinding, preserveNativeModel: true },
    });
    await expect(fixture.resolveOwnership()).resolves.toEqual({ model: "native", auth: "host" });
    await fixture.bindingStore.retireSessionGeneration(identity);

    await expect(fixture.resolveOwnership()).resolves.toBeUndefined();
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

      await expect(fixture.resolveOwnership({ assertCurrent })).rejects.toThrow(
        reason === "disposed" ? "harness is disposed" : "admission revoked",
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("rechecks admission after the lazy import and before reading private state", async () => {
    const fixture = createOwnershipFixture();
    const read = vi.spyOn(fixture.bindingStore, "read");
    let current = true;
    const resolving = fixture.resolveOwnership({
      assertCurrent() {
        if (!current) {
          throw new Error("admission revoked");
        }
      },
    });
    current = false;

    await expect(resolving).rejects.toThrow("admission revoked");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["revoked", "disposed"] as const)(
    "rejects ownership when admission becomes %s during the binding read",
    async (reason) => {
      const fixture = createOwnershipFixture();
      await fixture.bindingStore.mutate(identity, {
        kind: "set",
        binding: { ...observedBinding, preserveNativeModel: true },
      });
      const readBinding = fixture.bindingStore.read.bind(fixture.bindingStore);
      const started = createDeferred<void>();
      const released = createDeferred<void>();
      vi.spyOn(fixture.bindingStore, "read").mockImplementationOnce(async (requestedIdentity) => {
        const binding = await readBinding(requestedIdentity);
        started.resolve();
        await released.promise;
        return binding;
      });
      let current = true;
      const resolving = fixture.resolveOwnership({
        assertCurrent() {
          if (!current) {
            throw new Error("admission revoked");
          }
        },
      });
      await started.promise;
      if (reason === "disposed") {
        await fixture.harness.dispose?.();
      } else {
        current = false;
      }
      released.resolve();

      await expect(resolving).rejects.toThrow(
        reason === "disposed" ? "harness is disposed" : "admission revoked",
      );
    },
  );
});

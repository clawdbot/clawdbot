import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../../config/config.js";
import {
  __testing as sessionBindingTesting,
  type SessionBindingCapabilities,
  type SessionBindingRecord,
} from "../../../../infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest } from "../../../../plugins/runtime.js";
import { getSessionBindingContractRegistry } from "./registry-session-binding.js";

function resolveSessionBindingContractRuntimeConfig(id: string) {
  if (id !== "discord" && id !== "matrix") {
    return {};
  }
  return {
    plugins: {
      entries: {
        [id]: {
          enabled: true,
        },
      },
    },
  };
}

function installSessionBindingContractSuite(params: {
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
  expectedCapabilities: SessionBindingCapabilities;
}) {
  it("registers, binds, unbinds, and cleans up session bindings", async () => {
    expect(await Promise.resolve(params.getCapabilities())).toEqual(params.expectedCapabilities);
    const binding = await params.bindAndResolve();
    try {
      expect(typeof binding.bindingId).toBe("string");
      expect(binding.bindingId.trim()).not.toBe("");
      expect(typeof binding.targetSessionKey).toBe("string");
      expect(binding.targetSessionKey.trim()).not.toBe("");
      expect(["session", "subagent"]).toContain(binding.targetKind);
      expect(typeof binding.conversation.channel).toBe("string");
      expect(typeof binding.conversation.accountId).toBe("string");
      expect(typeof binding.conversation.conversationId).toBe("string");
      expect(["active", "ending", "ended"]).toContain(binding.status);
      expect(typeof binding.boundAt).toBe("number");
      await params.unbindAndVerify(binding);
    } finally {
      await params.cleanup();
    }
  });
}

export function describeSessionBindingRegistryBackedContract(id: string) {
  const entry = getSessionBindingContractRegistry().find((item) => item.id === id);
  if (!entry) {
    throw new Error(`missing session binding contract entry for ${id}`);
  }

  describe(`${entry.id} session binding contract`, () => {
    beforeAll(async () => {
      await entry.preload?.();
    });

    beforeEach(async () => {
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      // Keep the suite hermetic; some contract helpers resolve runtime artifacts through config-aware
      // plugin boundaries, so never fall back to the developer's real ~/.openclaw/openclaw.json here.
      const runtimeConfig = resolveSessionBindingContractRuntimeConfig(entry.id);
      // These registry-backed contract suites intentionally exercise bundled runtime facades.
      // Opt the bundled-runtime cases in so the activation boundary behaves like real runtime usage.
      setRuntimeConfigSnapshot(runtimeConfig);
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
      await entry.beforeEach?.();
    });
    afterEach(() => {
      clearRuntimeConfigSnapshot();
    });

    installSessionBindingContractSuite({
      expectedCapabilities: entry.expectedCapabilities,
      getCapabilities: entry.getCapabilities,
      bindAndResolve: entry.bindAndResolve,
      unbindAndVerify: entry.unbindAndVerify,
      cleanup: entry.cleanup,
    });
  });
}

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/config.js";
import {
  __testing as sessionBindingTesting,
  type SessionBindingCapabilities,
  type SessionBindingRecord,
} from "../../../src/infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest } from "../../../src/plugins/runtime.js";
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
  it("registers the expected session binding capabilities", async () => {
    expect(await Promise.resolve(params.getCapabilities())).toEqual(params.expectedCapabilities);
  });

  it("binds and resolves a session binding through the shared service", async () => {
    const binding = await params.bindAndResolve();
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
  });

  it("unbinds a registered binding through the shared service", async () => {
    const binding = await params.bindAndResolve();
    await params.unbindAndVerify(binding);
  });

  it("cleans up registered bindings", async () => {
    await params.cleanup();
  });
}

export function describeSessionBindingRegistryBackedContract(id: string) {
  const entry = getSessionBindingContractRegistry().find((item) => item.id === id);
  if (!entry) {
    throw new Error(`missing session binding contract entry for ${id}`);
  }

  describe(`${entry.id} session binding contract`, () => {
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

import type {
  OpenClawPluginApi,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/core";
// ClickClack discussion tests cover runtime lifecycle cleanup scoping.
import { createSessionVisibilityChecker } from "openclaw/plugin-sdk/session-visibility";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { serviceCleanup } = vi.hoisted(() => ({ serviceCleanup: vi.fn() }));

// The service opens a binding store against a live runtime; the lifecycle scope
// under test does not depend on it.
vi.mock("./service.js", () => ({
  ClickClackDiscussionService: class {
    provider = { id: "clickclack" };
    cleanup = serviceCleanup;
  },
}));

vi.mock("./tool-policy.js", () => ({
  enforceClickClackDiscussionToolTarget: vi.fn(),
  isClickClackDiscussionSessionTarget: vi.fn(() => ({ binding: { sessionId: "discussion-1" } })),
}));

import { registerClickClackDiscussions } from "./register.js";

// Derive from the registration contract so the test tracks the host's reason union.
type LifecycleCleanup = NonNullable<PluginRuntimeLifecycleRegistration["cleanup"]>;

// The scoped access provider registry is module state shared by every test in
// this file, so each registration must be released before the next case.
const registeredCleanups: LifecycleCleanup[] = [];

function registerAndCaptureCleanup(): LifecycleCleanup {
  let cleanup: LifecycleCleanup | undefined;
  const api = {
    registrationMode: "runtime",
    runtime: {},
    registerTool: vi.fn(),
    on: vi.fn(),
    lifecycle: {
      registerRuntimeLifecycle: (registration: PluginRuntimeLifecycleRegistration) => {
        cleanup = registration.cleanup;
      },
    },
  } as unknown as OpenClawPluginApi;
  registerClickClackDiscussions(api);
  if (!cleanup) {
    throw new Error("registerClickClackDiscussions did not register a runtime lifecycle cleanup");
  }
  registeredCleanups.push(cleanup);
  return cleanup;
}

function resolveDiscussionAccess() {
  return createSessionVisibilityChecker.resolveScopedAccess({
    action: "history",
    requesterSessionKey: "agent:main:clickclack:discussion",
    targetSessionKey: "agent:main:main",
  });
}

describe("ClickClack discussions runtime lifecycle", () => {
  beforeEach(() => {
    serviceCleanup.mockClear();
  });

  afterEach(async () => {
    for (const cleanup of registeredCleanups.splice(0)) {
      await cleanup({ reason: "disable" });
    }
    expect(resolveDiscussionAccess()).toBeUndefined();
  });

  // Session reset/delete runs every plugin's runtime cleanup, so a session-scoped
  // reason must leave the process-stable access provider registered.
  it.each(["reset", "delete"] as const)(
    "keeps the scoped access provider on a %s reason",
    async (reason) => {
      const cleanup = registerAndCaptureCleanup();
      expect(resolveDiscussionAccess()).toEqual({ expectedSessionId: "discussion-1" });

      await cleanup({ reason });

      expect(resolveDiscussionAccess()).toEqual({ expectedSessionId: "discussion-1" });
      expect(serviceCleanup).not.toHaveBeenCalled();
    },
  );

  it.each(["disable", "restart"] as const)(
    "releases the scoped access provider on a %s reason",
    async (reason) => {
      const cleanup = registerAndCaptureCleanup();
      expect(resolveDiscussionAccess()).toEqual({ expectedSessionId: "discussion-1" });

      await cleanup({ reason });

      expect(resolveDiscussionAccess()).toBeUndefined();
      expect(serviceCleanup).toHaveBeenCalledTimes(1);
    },
  );
});

/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import type { SidebarSessionMutationScope } from "./app-sidebar-session-types.ts";
import type { SessionActionHost } from "./session-organizer-batch-mutations.ts";
import { assignSessionOwner } from "./session-organizer-operations.runtime.ts";

function createHarness() {
  let current = true;
  let sessionError: string | null = null;
  let settleAssignment: ((result: null) => void) | undefined;
  const assignOwner = vi.fn(
    () =>
      new Promise<null>((resolve) => {
        settleAssignment = resolve;
      }),
  );
  const publishSessionMutationError = vi.fn();
  const snapshot = {
    client: {},
    phase: "connected",
    hello: gatewayHelloForMethods(["sessions.assignOwner"], ["operator.write"]),
  } as ApplicationGatewaySnapshot;
  const scope = {
    gateway: { snapshot },
    sessions: {
      assignOwner,
      get state() {
        return { error: sessionError };
      },
    } as unknown as SessionCapability,
    selectedAgentId: "main",
  } as SidebarSessionMutationScope;
  const host = {
    sessionData: {
      isSessionMutationScopeCurrent: vi.fn(() => current),
      publishSessionMutationError,
    },
  } as unknown as SessionActionHost;
  const session = {
    key: "agent:main:owner-proof",
  };
  return {
    assignOwner,
    host,
    publishSessionMutationError,
    retire: () => {
      current = false;
    },
    scope,
    session,
    setError: (error: string) => {
      sessionError = error;
    },
    settle: () => settleAssignment?.(null),
  };
}

describe("assignSessionOwner", () => {
  it("publishes a current capability rejection at the action surface", async () => {
    const harness = createHarness();
    const pending = assignSessionOwner(
      harness.host,
      harness.session,
      { type: "human", id: "profile-ada" },
      harness.scope,
    );

    harness.setError("Owner assignment rejected.");
    harness.settle();
    await pending;

    expect(harness.publishSessionMutationError).toHaveBeenCalledWith(
      harness.scope,
      "Owner assignment rejected.",
    );
  });

  it("keeps a retired assignment rejection silent", async () => {
    const harness = createHarness();
    const pending = assignSessionOwner(
      harness.host,
      harness.session,
      { type: "human", id: "profile-ada" },
      harness.scope,
    );

    harness.setError("Retired assignment rejection.");
    harness.retire();
    harness.settle();
    await pending;

    expect(harness.assignOwner).toHaveBeenCalledOnce();
    expect(harness.publishSessionMutationError).not.toHaveBeenCalled();
  });
});

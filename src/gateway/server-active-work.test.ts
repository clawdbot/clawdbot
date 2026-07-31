// Covers server-local chat, cron watcher, queued-turn, and terminal blockers.
import { describe, expect, it, vi } from "vitest";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

vi.mock("../cron/active-jobs.js", () => ({
  getActiveCronJobCount: vi.fn(() => 2),
}));

vi.mock("../cron/service/active-run-cancellation.js", () => ({
  getSuspensionVisibleCronTaskRunCount: vi.fn(() => 4),
}));

function controller(aborted = false): AbortController {
  const value = new AbortController();
  if (aborted) {
    value.abort();
  }
  return value;
}

describe("gateway server active work inspectors", () => {
  it("filters completed chat entries while retaining persistence and watcher blockers", () => {
    const context = {
      cron: { getSuspensionBlockerCount: () => 1 },
      chatAbortControllers: new Map([
        ["active", { controller: controller() }],
        ["aborted", { controller: controller(true) }],
        [
          "persisting",
          {
            controller: controller(),
            registrationCleanupRequested: true,
            controlUiVisible: true,
            projectSessionTerminalPending: true,
          },
        ],
      ]),
      chatQueuedTurns: new Map([
        ["queued", { controller: controller() }],
        ["cancelled", { controller: controller(true) }],
      ]),
      terminalSessions: { size: 2 },
    } as unknown as Pick<
      GatewayRequestContext,
      "chatAbortControllers" | "chatQueuedTurns" | "cron" | "terminalSessions"
    >;

    const inspectors = createGatewayServerActiveWorkInspectors(context);

    expect(inspectors.getCronRuns?.()).toBe(5);
    expect(inspectors.getChatRuns?.()).toBe(1);
    expect(inspectors.getQueuedTurns?.()).toBe(1);
    expect(inspectors.getTerminalPersistence?.()).toBe(1);
    expect(inspectors.getTerminalSessions?.()).toBe(2);
  });
});

/**
 * Guards the command lane that external hook agent-runs dispatch into.
 *
 * Hook runs used to pass `lane: "cron"`, which `resolveCronAgentLane` remaps to
 * `cron-nested` — the same lane cron's own inner agent work uses. A saturated
 * cron budget therefore starved every hook. Hook runs now dispatch into
 * `hook-dispatch` so they are schedulable in their own right; aggregate capacity
 * is bounded by the lane group that owns both lanes, not by adding a slot
 * outside the cron budget.
 *
 * This assertion is the only thing standing between that fix and a silent
 * regression: nothing else in the suite reads the dispatched lane, so reverting
 * the call site to `"cron"` leaves every other test green.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveCronAgentLane } from "../agents/lanes.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { CommandLane } from "../process/lanes.js";
import {
  cronIsolatedRun,
  installGatewayTestHooks,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await import("./server.js");

const HOOK_TOKEN = "hook-secret";

afterEach(() => {
  drainSystemEvents(resolveMainSessionKeyFromConfig());
  vi.restoreAllMocks();
});

async function postHook(
  port: number,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HOOK_TOKEN}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function waitForCronIsolatedRuns(count: number): Promise<void> {
  await expect
    .poll(() => cronIsolatedRun.mock.calls.length, { timeout: 2_000, interval: 10 })
    .toBe(count);
}

describe("gateway hook dispatch lane", () => {
  test("dispatches hook agent runs into the hook lane, not the cron lane", async () => {
    testState.hooksConfig = { enabled: true, token: HOOK_TOKEN };
    await withGatewayServer(async ({ port }) => {
      cronIsolatedRun.mockClear();
      cronIsolatedRun.mockImplementation(async (params: unknown) => {
        (params as { onExecutionStarted?: () => void }).onExecutionStarted?.();
        return { status: "ok", summary: "done" };
      });

      const response = await postHook(
        port,
        "/hooks/agent",
        { message: "Dispatch" },
        "hook-lane-idem",
      );
      expect(response.status).toBe(200);
      await waitForCronIsolatedRuns(1);

      const [dispatched] = cronIsolatedRun.mock.calls[0] as [{ lane?: string }];
      expect(dispatched.lane).toBe(CommandLane.HookDispatch);
      // The regression this guards: `"cron"` is the value that used to be passed.
      expect(dispatched.lane).not.toBe(CommandLane.Cron);
    });
  });

  test("the dispatched lane survives cron lane resolution unremapped", () => {
    // `resolveCronAgentLane` collapses empty and `cron` onto `cron-nested` and
    // passes every other lane through. The hook lane must land in the second
    // case, or the group reserves capacity for a lane nothing ever uses.
    expect(resolveCronAgentLane(CommandLane.HookDispatch)).toBe(CommandLane.HookDispatch);

    // Control: prove the assertion above can fail. These are the inputs that DO
    // get remapped, so a resolver that passed everything through unchanged
    // would break here rather than passing vacuously.
    expect(resolveCronAgentLane(CommandLane.Cron)).toBe(CommandLane.CronNested);
    expect(resolveCronAgentLane(undefined)).toBe(CommandLane.CronNested);
  });
});

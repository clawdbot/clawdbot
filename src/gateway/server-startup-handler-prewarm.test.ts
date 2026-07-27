import { afterEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  GATEWAY_HANDLER_PREWARM_FAMILY_NAMES,
  scheduleGatewayHandlerPrewarm,
  type GatewayHandlerPrewarmFamily,
} from "./server-startup-handler-prewarm.js";

afterEach(() => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

describe("scheduleGatewayHandlerPrewarm", () => {
  it("loads every dashboard family only after the post-ready timer yields", async () => {
    vi.useFakeTimers();
    expect(GATEWAY_HANDLER_PREWARM_FAMILY_NAMES).toEqual([
      "sessions",
      "chat",
      "tasks",
      "cron",
      "models-auth-status",
      "agent-identity",
      "board",
      "channels",
    ]);
    const loaded: string[] = [];
    const families: GatewayHandlerPrewarmFamily[] = GATEWAY_HANDLER_PREWARM_FAMILY_NAMES.map(
      (name) => ({
        name,
        load: vi.fn(async () => {
          loaded.push(name);
        }),
      }),
    );

    const sidecar = scheduleGatewayHandlerPrewarm({
      families,
      log: { warn: vi.fn() },
    });

    expect(loaded).toEqual([]);
    await vi.runAllTimersAsync();
    expect(loaded).toEqual(GATEWAY_HANDLER_PREWARM_FAMILY_NAMES);
    expect(families.every((family) => vi.mocked(family.load).mock.calls.length === 1)).toBe(true);
    sidecar.stop();
  });

  it("stops before importing a scheduled family", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => {});
    const sidecar = scheduleGatewayHandlerPrewarm({
      families: [{ name: "sessions", load }],
      log: { warn: vi.fn() },
    });

    sidecar.stop();
    await vi.runAllTimersAsync();
    expect(load).not.toHaveBeenCalled();
  });
});

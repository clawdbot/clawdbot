import { afterEach, describe, expect, it, vi } from "vitest";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { scheduleGatewayHandlerPrewarm } from "./server-startup-handler-prewarm.js";

afterEach(() => {
  vi.useRealTimers();
  resetGatewayWorkAdmission();
});

describe("scheduleGatewayHandlerPrewarm", () => {
  it("loads every scheduled family in order only after the post-ready timer yields", async () => {
    vi.useFakeTimers();
    const familyNames = ["sessions", "chat", "tasks", "cron"];
    const loaded: string[] = [];
    const families = familyNames.map((name) => ({
      name,
      load: vi.fn(async () => {
        loaded.push(name);
      }),
    }));

    const sidecar = scheduleGatewayHandlerPrewarm({
      families,
      log: { warn: vi.fn() },
    });

    expect(loaded).toEqual([]);
    await vi.runAllTimersAsync();
    expect(loaded).toEqual(familyNames);
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

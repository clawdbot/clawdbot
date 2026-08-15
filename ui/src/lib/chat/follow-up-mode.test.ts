import { describe, expect, it } from "vitest";
import { resolveControlUiFollowUpMode, resolveControlUiServerQueueMode } from "./follow-up-mode.js";

describe("Control UI follow-up mode", () => {
  it("matches webchat queue resolution precedence", () => {
    expect(resolveControlUiServerQueueMode({})).toBe("steer");
    expect(resolveControlUiServerQueueMode(undefined)).toBeUndefined();
    expect(resolveControlUiServerQueueMode({ messages: { queue: { mode: "followup" } } })).toBe(
      "followup",
    );
    expect(
      resolveControlUiServerQueueMode({
        messages: { queue: { byChannel: { webchat: "collect" }, mode: "interrupt" } },
      }),
    ).toBe("collect");
    expect(
      resolveControlUiServerQueueMode(
        { messages: { queue: { byChannel: { webchat: "collect" }, mode: "interrupt" } } },
        { sessionMode: "followup" },
      ),
    ).toBe("followup");
    expect(resolveControlUiServerQueueMode(undefined, { effectiveMode: "followup" })).toBe(
      "followup",
    );
  });

  it("distinguishes saved config from applied config", () => {
    const savedConfig = { messages: { queue: { byChannel: { webchat: "followup" } } } };
    expect(
      resolveControlUiServerQueueMode(savedConfig, {
        configNeedsApply: true,
        effectiveMode: "steer",
      }),
    ).toBe("steer");
    expect(
      resolveControlUiServerQueueMode(savedConfig, {
        configNeedsApply: true,
      }),
    ).toBeUndefined();
    expect(
      resolveControlUiServerQueueMode(savedConfig, {
        sessionMetadataLoaded: false,
      }),
    ).toBeUndefined();
    expect(
      resolveControlUiServerQueueMode(savedConfig, {
        effectiveMode: "steer",
      }),
    ).toBe("followup");
    expect(
      resolveControlUiServerQueueMode(savedConfig, {
        effectiveMode: "steer",
        sessionMode: "interrupt",
      }),
    ).toBe("interrupt");
  });

  it("inherits the server behavior until the browser has an explicit override", () => {
    expect(resolveControlUiFollowUpMode(undefined, undefined)).toBeUndefined();
    expect(resolveControlUiFollowUpMode(undefined, "steer")).toBe("steer");
    expect(resolveControlUiFollowUpMode(undefined, "followup")).toBe("followup");
    expect(resolveControlUiFollowUpMode(undefined, "collect")).toBe("collect");
    expect(resolveControlUiFollowUpMode(undefined, "interrupt")).toBe("interrupt");
    expect(resolveControlUiFollowUpMode("queue", "steer")).toBe("queue");
    expect(resolveControlUiFollowUpMode("steer", "interrupt")).toBe("steer");
  });
});

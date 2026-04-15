import { describe, expect, it } from "vitest";
import { resolveIdleProfileStopOutcome } from "./server-context.lifecycle.js";
import { makeBrowserProfile } from "./server-context.test-harness.js";

describe("resolveIdleProfileStopOutcome", () => {
  it("treats attachOnly profiles as stopped via Playwright cleanup", () => {
    expect(resolveIdleProfileStopOutcome(makeBrowserProfile({ attachOnly: true }))).toEqual({
      stopped: true,
      closePlaywright: true,
    });
  });

  it("treats remote CDP profiles as stopped via Playwright cleanup", () => {
    expect(
      resolveIdleProfileStopOutcome(
        makeBrowserProfile({
          cdpUrl: "http://10.0.0.5:9222",
          cdpHost: "10.0.0.5",
          cdpIsLoopback: false,
          cdpPort: 9222,
        }),
      ),
    ).toEqual({
      stopped: true,
      closePlaywright: true,
    });
  });

  it("keeps never-started managed profiles as not stopped", () => {
    expect(resolveIdleProfileStopOutcome(makeBrowserProfile())).toEqual({
      stopped: false,
      closePlaywright: false,
    });
  });
});

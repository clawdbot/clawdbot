// Control UI tests cover control ui e2e behavior.
import { describe, expect, it } from "vitest";
import {
  resolvePlaywrightChromiumExecutablePath,
  systemChromiumExecutableCandidates,
} from "./control-ui-e2e.ts";

describe("resolvePlaywrightChromiumExecutablePath", () => {
  it("uses a runnable system Chromium when the cached Playwright executable cannot start", () => {
    const systemExecutable = systemChromiumExecutableCandidates[1];

    expect(
      resolvePlaywrightChromiumExecutablePath(
        "/cache/chromium/chrome",
        {},
        (candidate) => candidate === systemExecutable,
      ),
    ).toBe(systemExecutable);
  });

  it("keeps explicit Chromium overrides authoritative", () => {
    expect(
      resolvePlaywrightChromiumExecutablePath(
        "/cache/chromium/chrome",
        { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: " /custom/chromium " },
        () => false,
      ),
    ).toBe("/custom/chromium");
  });
});

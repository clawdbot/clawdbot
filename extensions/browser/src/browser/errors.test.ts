import { describe, expect, it } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import {
  BROWSER_ENDPOINT_BLOCKED_MESSAGE,
  BROWSER_NAVIGATION_BLOCKED_MESSAGE,
  BrowserCdpEndpointBlockedError,
  BrowserValidationError,
  toBrowserErrorResponse,
} from "./errors.js";

describe("browser error mapping", () => {
  it("maps blocked browser targets to conflict responses", () => {
    const err = new Error(
      "Browser target is unavailable after SSRF policy blocked its navigation.",
    );
    err.name = "BlockedBrowserTargetError";

    expect(toBrowserErrorResponse(err)).toEqual({
      status: 409,
      message: "Browser target is unavailable after SSRF policy blocked its navigation.",
    });
  });

  it("preserves BrowserError mappings", () => {
    expect(toBrowserErrorResponse(new BrowserValidationError("bad input"))).toEqual({
      status: 400,
      message: "bad input",
    });
  });

  it("sanitizes navigation-target SSRF policy errors without leaking raw policy details", () => {
    expect(
      toBrowserErrorResponse(
        new SsrFBlockedError("Blocked hostname or private/internal/special-use IP address"),
      ),
    ).toEqual({
      status: 400,
      message: BROWSER_NAVIGATION_BLOCKED_MESSAGE,
    });
  });

  it("maps CDP endpoint policy blocks to a distinct endpoint-scoped message", () => {
    expect(toBrowserErrorResponse(new BrowserCdpEndpointBlockedError())).toEqual({
      status: 400,
      message: BROWSER_ENDPOINT_BLOCKED_MESSAGE,
    });
  });
});

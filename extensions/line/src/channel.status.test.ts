import { describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "../api.js";
import { lineStatusAdapter } from "./status.js";

function collectIssues(accounts: ChannelAccountSnapshot[]) {
  const collect = lineStatusAdapter.collectStatusIssues;
  if (!collect) {
    throw new Error("LINE plugin status collector is unavailable");
  }
  return collect(accounts);
}

describe("linePlugin status.collectStatusIssues", () => {
  it("does not warn when a sanitized snapshot is configured", () => {
    expect(
      collectIssues([
        {
          accountId: "default",
          configured: true,
          tokenSource: "env",
        },
      ]),
    ).toEqual([]);
  });

  it("reports missing access token when the snapshot is unconfigured and tokenSource is none", () => {
    expect(
      collectIssues([
        {
          accountId: "default",
          configured: false,
          tokenSource: "none",
        },
      ]),
    ).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel access token not configured",
      },
    ]);
  });

  it("reports missing secret when the snapshot is unconfigured but a token source exists", () => {
    expect(
      collectIssues([
        {
          accountId: "default",
          configured: false,
          tokenSource: "env",
        },
      ]),
    ).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message: "LINE channel secret not configured",
      },
    ]);
  });
});

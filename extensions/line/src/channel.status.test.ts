// Line tests cover channel.status plugin behavior.
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
  it("projects lifecycle from the runtime status record", async () => {
    const snapshot = await lineStatusAdapter.buildAccountSnapshot?.({
      cfg: {},
      account: {
        accountId: "default",
        name: "LINE",
        enabled: true,
        configured: true,
        channelAccessToken: "token",
        channelSecret: "secret",
        tokenSource: "config",
        signingSecretSource: "config",
        tokenStatus: "available",
        signingSecretStatus: "available",
        config: {},
      } as never,
      runtime: { accountId: "default", lifecycle: "recovering", connected: false },
    });
    expect(snapshot).toMatchObject({ lifecycle: "recovering", connected: false });
  });

  it.each([
    {
      name: "registered but switched off",
      webhook: { status: "disabled", endpoint: "https://gateway.example/line/webhook" },
      message:
        "LINE is not delivering webhook events: this channel's webhook URL is registered but switched off.",
    },
    {
      name: "never registered",
      webhook: { status: "unset" },
      message: "LINE is not delivering webhook events: this channel has no webhook URL registered.",
    },
  ])("reports a webhook that is $name", ({ webhook, message }) => {
    expect(
      collectIssues([
        {
          accountId: "default",
          enabled: true,
          configured: true,
          tokenSource: "config",
          probe: { ok: true, webhook },
        },
      ]),
    ).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message,
        fix: "open the channel's Messaging API tab in the LINE Developers Console, set the webhook URL to your gateway's /line/webhook path, and turn Use webhook on",
      },
    ]);
  });

  it("stays quiet about the webhook when it is on, and when LINE did not answer", () => {
    expect(
      collectIssues([
        {
          accountId: "default",
          enabled: true,
          configured: true,
          tokenSource: "config",
          probe: {
            ok: true,
            webhook: { status: "active", endpoint: "https://gateway.example/line/webhook" },
          },
        },
        {
          accountId: "quiet",
          enabled: true,
          configured: true,
          tokenSource: "config",
          probe: { ok: false, error: "timeout" },
        },
      ]),
    ).toStrictEqual([]);
  });

  it("does not warn when a sanitized snapshot is configured", () => {
    expect(
      collectIssues([
        {
          accountId: "default",
          configured: true,
          tokenSource: "env",
        },
      ]),
    ).toStrictEqual([]);
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

// Line tests cover channel.status plugin behavior.
import { describe, expect, it } from "vitest";
import type { ChannelAccountSnapshot } from "../api.js";
import { lineStatusAdapter } from "./status.js";
import type { ResolvedLineAccount } from "./types.js";

async function buildSnapshot(account: ResolvedLineAccount): Promise<ChannelAccountSnapshot> {
  const build = lineStatusAdapter.buildAccountSnapshot;
  if (!build) {
    throw new Error("LINE plugin status snapshot builder is unavailable");
  }
  return await build({
    cfg: {},
    account,
    probe: { ok: true, webhook: { status: "unset" } },
  });
}

function collectIssues(accounts: ChannelAccountSnapshot[]) {
  const collect = lineStatusAdapter.collectStatusIssues;
  if (!collect) {
    throw new Error("LINE plugin status collector is unavailable");
  }
  return collect(accounts);
}

describe("linePlugin status.collectStatusIssues", () => {
  // The route is published by resolveAccountSnapshot and read back by the issue
  // collector. Every other case writes the field onto a fixture, so a rename on either
  // side would fall back to the default in silence; this one goes through both.
  it("carries the account's configured route from the snapshot into the warning", async () => {
    const snapshot = await buildSnapshot({
      accountId: "default",
      enabled: true,
      channelAccessToken: "token",
      channelSecret: "secret",
      tokenSource: "config",
      signingSecretSource: "config",
      tokenStatus: "available",
      signingSecretStatus: "available",
      config: { webhookPath: "hooks/line-primary/" },
    });

    expect(collectIssues([snapshot])).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message:
          "LINE is not delivering webhook events: this channel has no webhook URL registered.",
        fix: "register your gateway's public HTTPS URL ending in /hooks/line-primary in the channel's Messaging API tab in the LINE Developers Console, then turn Use webhook on",
      },
    ]);
  });

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
      fix: "turn Use webhook on for https://gateway.example/line/webhook in the channel's Messaging API tab in the LINE Developers Console",
    },
    {
      name: "never registered",
      webhook: { status: "unset" },
      message: "LINE is not delivering webhook events: this channel has no webhook URL registered.",
      fix: "register your gateway's public HTTPS URL ending in /line/webhook in the channel's Messaging API tab in the LINE Developers Console, then turn Use webhook on",
    },
  ])("reports a webhook that is $name", ({ webhook, message, fix }) => {
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
        fix,
      },
    ]);
  });

  // A warning that names a route the account does not serve leaves the bot silent
  // while telling the operator they have fixed it.
  it("names the account's own route when no webhook is registered", () => {
    expect(
      collectIssues([
        {
          accountId: "default",
          enabled: true,
          configured: true,
          tokenSource: "config",
          webhookPath: "/hooks/line-primary",
          probe: { ok: true, webhook: { status: "unset" } },
        },
      ]),
    ).toEqual([
      {
        channel: "line",
        accountId: "default",
        kind: "config",
        message:
          "LINE is not delivering webhook events: this channel has no webhook URL registered.",
        fix: "register your gateway's public HTTPS URL ending in /hooks/line-primary in the channel's Messaging API tab in the LINE Developers Console, then turn Use webhook on",
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

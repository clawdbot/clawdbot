import { describe, expect, it } from "vitest";
import { stripBrowserOpenInternalMetadata } from "./browser-tool-session-tabs.js";
import { executeTabsAction } from "./browser-tool.actions.js";
import { normalizeCdpWsUrl } from "./browser/cdp.js";

const CDP_USER = "admin";
const CDP_PASSWORD = "s3cr3t-pass";
const CDP_TOKEN = "BROWSERLESS_TOKEN_123";
const REPORTED_WS = "ws://0.0.0.0:9222/devtools/page/AAA111";

function remoteCdpUrl(): string {
  const url = new URL("https://chrome.example.net");
  url.username = CDP_USER;
  url.password = CDP_PASSWORD;
  url.searchParams.set("token", CDP_TOKEN);
  return url.toString();
}

function credentialBearingWsUrl(): string {
  const wsUrl = normalizeCdpWsUrl(REPORTED_WS, remoteCdpUrl());
  expect(wsUrl).toContain(`${CDP_USER}:${CDP_PASSWORD}@`);
  expect(wsUrl).toContain(`token=${CDP_TOKEN}`);
  return wsUrl;
}

describe("browser tool tab output redaction", () => {
  it("omits the CDP wsUrl from action=tabs model output", async () => {
    const wsUrl = credentialBearingWsUrl();
    const result = await executeTabsAction({
      profile: "remote",
      proxyRequest: (async () => ({
        running: true,
        tabs: [
          {
            targetId: "AAA111",
            title: "Inbox",
            url: "https://mail.example.com",
            type: "page",
            wsUrl,
          },
        ],
      })) as never,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CDP_PASSWORD);
    expect(serialized).not.toContain(CDP_TOKEN);
    expect(serialized).not.toContain("wsUrl");
    expect(serialized).toContain("AAA111");
    expect(serialized).toContain("https://mail.example.com");
  });

  it("omits the CDP wsUrl from action=open model output", () => {
    const wsUrl = credentialBearingWsUrl();
    const stripped = stripBrowserOpenInternalMetadata({
      targetId: "AAA111",
      title: "Inbox",
      url: "https://mail.example.com",
      type: "page",
      wsUrl,
      wsLookup: () => undefined,
      ownership: { status: "durable" },
      resolvedProfile: "remote",
    });
    const serialized = JSON.stringify(stripped);
    expect(serialized).not.toContain(CDP_PASSWORD);
    expect(serialized).not.toContain(CDP_TOKEN);
    expect(stripped).not.toHaveProperty("wsUrl");
    expect(stripped).not.toHaveProperty("wsLookup");
    expect(stripped).toHaveProperty("targetId", "AAA111");
  });
});

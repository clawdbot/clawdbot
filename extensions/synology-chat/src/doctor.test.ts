import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { synologyChatDoctor } from "./doctor.js";

async function collectWarnings(cfg: OpenClawConfig): Promise<string[]> {
  return (
    (await synologyChatDoctor.collectPreviewWarnings?.({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
    })) ?? []
  );
}

describe("synologyChatDoctor", () => {
  it("reports an attachment-only setup gap without calling the account unconfigured", async () => {
    const warnings = await collectWarnings({
      channels: {
        "synology-chat": {
          enabled: true,
          token: "token",
          incomingUrl: "https://nas.example.com/incoming",
        },
      },
    });
    expect(warnings.join("\n")).toContain("attachments are unavailable");
    expect(warnings.join("\n")).toContain("Text and inbound messages are unaffected");
  });

  it("accepts a valid exact HTTPS callback and reports invalid values", async () => {
    const valid = await collectWarnings({
      channels: {
        "synology-chat": {
          enabled: true,
          token: "token",
          incomingUrl: "https://nas.example.com/incoming",
          webhookUrl: "https://gateway.example.com/webhook/synology?proxy=keep",
        },
      },
    });
    expect(valid).toEqual([]);

    const invalid = await collectWarnings({
      channels: {
        "synology-chat": {
          enabled: true,
          token: "token",
          incomingUrl: "https://nas.example.com/incoming",
          webhookUrl: "http://gateway.example.com/webhook/synology",
        },
      },
    });
    expect(invalid.join("\n")).toContain("must be an absolute HTTPS URL");
  });

  it("requires a named route to configure its own exact public callback", async () => {
    const warnings = await collectWarnings({
      channels: {
        "synology-chat": {
          token: "base-token",
          incomingUrl: "https://nas.example.com/incoming",
          webhookUrl: "https://gateway.example.com/webhook/synology",
          accounts: {
            work: {
              token: "work-token",
              webhookPath: "/webhook/synology-work",
            },
          },
        },
      },
    });

    expect(warnings.join("\n")).toContain(
      "channels.synology-chat.accounts.work.webhookUrl: attachments are unavailable",
    );
  });
});

import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";
import {
  BlueBubblesConfigSchema,
  IMessageConfigSchema,
  SignalConfigSchema,
  TelegramConfigSchema,
} from "./zod-schema.providers-core.js";
import { WhatsAppConfigSchema } from "./zod-schema.providers-whatsapp.js";

describe("config schema regressions", () => {
  it("accepts nested telegram groupPolicy overrides", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          topics: {
            "42": {
              groupPolicy: "disabled",
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts telegram actions editMessage and createForumTopic", () => {
    const res = TelegramConfigSchema.safeParse({
      actions: {
        editMessage: true,
        createForumTopic: false,
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts channels.whatsapp.enabled", () => {
    const res = WhatsAppConfigSchema.safeParse({
      enabled: true,
    });

    expect(res.success).toBe(true);
  });

  it("accepts signal accountUuid for loop protection", () => {
    const res = SignalConfigSchema.safeParse({
      accountUuid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });

    expect(res.success).toBe(true);
  });

  it("accepts BlueBubbles enrichGroupParticipantsFromContacts at channel and account scope", () => {
    const res = BlueBubblesConfigSchema.safeParse({
      enrichGroupParticipantsFromContacts: true,
      accounts: {
        work: {
          enrichGroupParticipantsFromContacts: false,
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch provider "mistral"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "mistral",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch provider "bedrock"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            provider: "bedrock",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts memorySearch.qmd.extraCollections", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            qmd: {
              extraCollections: [
                { path: "/shared/team-notes", name: "team-notes", pattern: "**/*.md" },
              ],
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts agents.list[].memorySearch.qmd.extraCollections", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            memorySearch: {
              qmd: {
                extraCollections: [
                  { path: "/shared/team-notes", name: "team-notes", pattern: "**/*.md" },
                ],
              },
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts agents.defaults.startupContext overrides", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          startupContext: {
            enabled: true,
            applyOn: ["new"],
            dailyMemoryDays: 3,
            maxFileBytes: 8192,
            maxFileChars: 1000,
            maxTotalChars: 2500,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects oversized agents.defaults.startupContext overrides", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          startupContext: {
            dailyMemoryDays: 99,
            maxFileBytes: 999_999,
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts safe iMessage remoteHost", () => {
    const res = IMessageConfigSchema.safeParse({
      remoteHost: "bot@gateway-host",
    });

    expect(res.success).toBe(true);
  });

  it("rejects unsafe iMessage remoteHost", () => {
    const res = IMessageConfigSchema.safeParse({
      remoteHost: "bot@gateway-host -oProxyCommand=whoami",
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("remoteHost");
    }
  });

  it("accepts iMessage attachment root patterns", () => {
    const res = IMessageConfigSchema.safeParse({
      attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
      remoteAttachmentRoots: ["/Volumes/relay/attachments"],
    });

    expect(res.success).toBe(true);
  });

  it("accepts string values for agents defaults model inputs", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          imageModel: "openai/gpt-4.1-mini",
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts pdf default model and limits", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          pdfModel: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.4-mini"],
          },
          pdfMaxBytesMb: 12,
          pdfMaxPages: 25,
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects non-positive pdf limits", () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          pdfModel: { primary: "openai/gpt-5.4-mini" },
          pdfMaxBytesMb: 0,
          pdfMaxPages: 0,
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path.includes("agents.defaults.pdfMax"))).toBe(true);
    }
  });

  it("rejects relative iMessage attachment roots", () => {
    const res = IMessageConfigSchema.safeParse({
      attachmentRoots: ["./attachments"],
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("attachmentRoots.0");
    }
  });

  it("accepts browser.extraArgs for proxy and custom flags", () => {
    const res = validateConfigObject({
      browser: {
        extraArgs: ["--proxy-server=http://127.0.0.1:7890"],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects browser.extraArgs with non-array value", () => {
    const res = validateConfigObject({
      browser: {
        extraArgs: "--proxy-server=http://127.0.0.1:7890" as unknown,
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts tools.media.asyncCompletion.directSend", () => {
    const res = validateConfigObject({
      tools: {
        media: {
          asyncCompletion: {
            directSend: true,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
  it("accepts discovery.wideArea.domain for unicast DNS-SD", () => {
    const res = validateConfigObject({
      discovery: {
        wideArea: {
          enabled: true,
          domain: "openclaw.internal",
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});

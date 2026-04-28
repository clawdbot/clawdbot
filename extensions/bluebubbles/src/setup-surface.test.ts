import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  createSetupWizardAdapter,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveBlueBubblesAccount } from "./accounts.js";
import { BlueBubblesConfigSchema } from "./config-schema.js";
import {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
} from "./group-policy.js";
import { blueBubblesSetupAdapter, blueBubblesSetupWizard } from "./setup-surface.js";
import {
  inferBlueBubblesTargetChatType,
  isAllowedBlueBubblesSender,
  looksLikeBlueBubblesExplicitTargetId,
  looksLikeBlueBubblesTargetId,
  normalizeBlueBubblesMessagingTarget,
  parseBlueBubblesAllowTarget,
  parseBlueBubblesTarget,
} from "./targets.js";
import { DEFAULT_WEBHOOK_PATH } from "./webhook-shared.js";

async function createBlueBubblesConfigureAdapter() {
  const plugin = {
    id: "bluebubbles",
    meta: {
      id: "bluebubbles",
      label: "BlueBubbles",
      selectionLabel: "BlueBubbles",
      docsPath: "/channels/bluebubbles",
      blurb: "iMessage via BlueBubbles",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      resolveAccount: adaptScopedAccountAccessor(resolveBlueBubblesAccount),
      resolveAllowFrom: ({ cfg, accountId }: { cfg: unknown; accountId: string }) =>
        resolveBlueBubblesAccount({
          cfg: cfg as Parameters<typeof resolveBlueBubblesAccount>[0]["cfg"],
          accountId,
        }).config.allowFrom ?? [],
    },
    setup: blueBubblesSetupAdapter,
  } as Parameters<typeof createSetupWizardAdapter>[0]["plugin"];
  return createSetupWizardAdapter({
    plugin,
    wizard: blueBubblesSetupWizard,
  });
}

async function runBlueBubblesConfigure(params: { cfg: unknown; prompter: WizardPrompter }) {
  const adapter = await createBlueBubblesConfigureAdapter();
  type ConfigureContext = Parameters<NonNullable<typeof adapter.configure>>[0];
  return await runSetupWizardConfigure({
    configure: adapter.configure,
    cfg: params.cfg as ConfigureContext["cfg"],
    runtime: { ...console, exit: vi.fn() } as ConfigureContext["runtime"],
    prompter: params.prompter,
  });
}

describe("bluebubbles setup surface", () => {
  it("preserves existing password SecretRef and keeps default webhook path", async () => {
    const passwordRef = { source: "env", provider: "default", id: "BLUEBUBBLES_PASSWORD" };
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const text = vi.fn();

    const result = await runBlueBubblesConfigure({
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://127.0.0.1:1234",
            password: passwordRef,
          },
        },
      },
      prompter: createTestWizardPrompter({ confirm, text }),
    });

    expect(result.cfg.channels?.bluebubbles?.password).toEqual(passwordRef);
    expect(result.cfg.channels?.bluebubbles?.webhookPath).toBe(DEFAULT_WEBHOOK_PATH);
    expect(text).not.toHaveBeenCalled();
  });

  it("applies a custom webhook path when requested", async () => {
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const text = vi.fn().mockResolvedValueOnce("/custom-bluebubbles");

    const result = await runBlueBubblesConfigure({
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://127.0.0.1:1234",
            password: "secret",
          },
        },
      },
      prompter: createTestWizardPrompter({ confirm, text }),
    });

    expect(result.cfg.channels?.bluebubbles?.webhookPath).toBe("/custom-bluebubbles");
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Webhook path",
        placeholder: DEFAULT_WEBHOOK_PATH,
      }),
    );
  });

  it("validates server URLs before accepting input", async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false);
    const text = vi.fn().mockResolvedValueOnce("127.0.0.1:1234").mockResolvedValueOnce("secret");

    await runBlueBubblesConfigure({
      cfg: { channels: { bluebubbles: {} } },
      prompter: createTestWizardPrompter({ confirm, text }),
    });

    const serverUrlPrompt = text.mock.calls[0]?.[0] as {
      validate?: (value: string) => string | undefined;
    };
    expect(serverUrlPrompt.validate?.("bad url")).toBe("Invalid URL format");
    expect(serverUrlPrompt.validate?.("127.0.0.1:1234")).toBeUndefined();
  });

  it("disables the channel through the setup wizard", async () => {
    const next = blueBubblesSetupWizard.disable?.({
      channels: {
        bluebubbles: {
          enabled: true,
          serverUrl: "http://127.0.0.1:1234",
        },
      },
    });

    expect(next?.channels?.bluebubbles?.enabled).toBe(false);
  });

  it("reads the named-account DM policy instead of the channel root", async () => {
    expect(
      blueBubblesSetupWizard.dmPolicy?.getCurrent(
        {
          channels: {
            bluebubbles: {
              dmPolicy: "disabled",
              accounts: {
                work: {
                  serverUrl: "http://localhost:1234",
                  password: "secret",
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        },
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", async () => {
    expect(blueBubblesSetupWizard.dmPolicy?.resolveConfigKeys?.({}, "work")).toEqual({
      policyKey: "channels.bluebubbles.accounts.work.dmPolicy",
      allowFromKey: "channels.bluebubbles.accounts.work.allowFrom",
    });
  });

  it("uses configured defaultAccount for omitted DM policy account context", async () => {
    const cfg = {
      channels: {
        bluebubbles: {
          defaultAccount: "work",
          dmPolicy: "disabled",
          allowFrom: ["user@example.com"],
          accounts: {
            work: {
              serverUrl: "http://localhost:1234",
              password: "secret",
              dmPolicy: "allowlist",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(blueBubblesSetupWizard.dmPolicy?.getCurrent(cfg)).toBe("allowlist");
    expect(blueBubblesSetupWizard.dmPolicy?.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.bluebubbles.accounts.work.dmPolicy",
      allowFromKey: "channels.bluebubbles.accounts.work.allowFrom",
    });

    const next = blueBubblesSetupWizard.dmPolicy?.setPolicy(cfg, "open");
    const workAccount = next?.channels?.bluebubbles?.accounts?.work as
      | {
          dmPolicy?: string;
        }
      | undefined;
    expect(next?.channels?.bluebubbles?.dmPolicy).toBe("disabled");
    expect(workAccount?.dmPolicy).toBe("open");
  });

  it("uses configured defaultAccount when accountId is omitted in account resolution", async () => {
    const resolved = resolveBlueBubblesAccount({
      cfg: {
        channels: {
          bluebubbles: {
            defaultAccount: "work",
            serverUrl: "http://localhost:3000",
            password: "top-secret",
            accounts: {
              work: {
                serverUrl: "http://localhost:1234",
                password: "secret",
                name: "Work",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.baseUrl).toBe("http://localhost:1234");
    expect(resolved.configured).toBe(true);
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await blueBubblesSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          bluebubbles: {
            defaultAccount: "work",
            serverUrl: "http://localhost:3000",
            password: "top-secret",
            accounts: {
              alerts: {
                serverUrl: "http://localhost:4000",
                password: "alerts-secret",
              },
              work: {
                serverUrl: "",
                password: "",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(false);
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', async () => {
    const next = blueBubblesSetupWizard.dmPolicy?.setPolicy(
      {
        channels: {
          bluebubbles: {
            allowFrom: ["user@example.com"],
            accounts: {
              work: {
                serverUrl: "http://localhost:1234",
                password: "secret",
              },
            },
          },
        },
      },
      "open",
      "work",
    );

    const workAccount = next?.channels?.bluebubbles?.accounts?.work as
      | {
          dmPolicy?: string;
          allowFrom?: string[];
        }
      | undefined;
    expect(next?.channels?.bluebubbles?.dmPolicy).toBeUndefined();
    expect(workAccount?.dmPolicy).toBe("open");
    expect(workAccount?.allowFrom).toEqual(["user@example.com", "*"]);
  });
});

describe("resolveBlueBubblesAccount", () => {
  it("treats SecretRef passwords as configured when serverUrl exists", () => {
    const resolved = resolveBlueBubblesAccount({
      cfg: {
        channels: {
          bluebubbles: {
            enabled: true,
            serverUrl: "http://localhost:1234",
            password: {
              source: "env",
              provider: "default",
              id: "BLUEBUBBLES_PASSWORD",
            },
          },
        },
      },
    });

    expect(resolved.configured).toBe(true);
    expect(resolved.baseUrl).toBe("http://localhost:1234");
  });

  it("strips stale legacy private-network aliases after canonical normalization", () => {
    const resolved = resolveBlueBubblesAccount({
      cfg: {
        channels: {
          bluebubbles: {
            network: {
              allowPrivateNetwork: true,
            },
            accounts: {
              work: {
                serverUrl: "http://localhost:1234",
                password: "secret", // pragma: allowlist secret
                network: {
                  dangerouslyAllowPrivateNetwork: false,
                },
              },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.network).toEqual({
      dangerouslyAllowPrivateNetwork: false,
    });
    expect("allowPrivateNetwork" in resolved.config).toBe(false);
    expect(isPrivateNetworkOptInEnabled(resolved.config)).toBe(false);
  });
});

describe("BlueBubblesConfigSchema", () => {
  it("accepts account config when serverUrl and password are both set", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
      password: "secret", // pragma: allowlist secret
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts SecretRef password when serverUrl is set", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
      password: {
        source: "env",
        provider: "default",
        id: "BLUEBUBBLES_PASSWORD",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("requires password when top-level serverUrl is configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(parsed.error.issues[0]?.path).toEqual(["password"]);
    expect(parsed.error.issues[0]?.message).toBe(
      "password is required when serverUrl is configured",
    );
  });

  it("requires password when account serverUrl is configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        work: {
          serverUrl: "http://localhost:1234",
        },
      },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }
    expect(parsed.error.issues[0]?.path).toEqual(["accounts", "work", "password"]);
    expect(parsed.error.issues[0]?.message).toBe(
      "password is required when serverUrl is configured",
    );
  });

  it("allows password omission when serverUrl is not configured", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        work: {
          name: "Work iMessage",
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("defaults enrichGroupParticipantsFromContacts to true", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      serverUrl: "http://localhost:1234",
      password: "secret", // pragma: allowlist secret
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.enrichGroupParticipantsFromContacts).toBe(true);
  });

  it("defaults account enrichGroupParticipantsFromContacts to true", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      accounts: {
        work: {
          serverUrl: "http://localhost:1234",
          password: "secret", // pragma: allowlist secret
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const accountConfig = (
      parsed.data as { accounts?: { work?: { enrichGroupParticipantsFromContacts?: boolean } } }
    ).accounts?.work;
    expect(accountConfig?.enrichGroupParticipantsFromContacts).toBe(true);
  });

  it("accepts explicit enrichGroupParticipantsFromContacts at channel and account scope", () => {
    const parsed = BlueBubblesConfigSchema.safeParse({
      enrichGroupParticipantsFromContacts: true,
      accounts: {
        work: {
          enrichGroupParticipantsFromContacts: false,
        },
      },
    });

    expect(parsed.success).toBe(true);
  });
});

describe("bluebubbles group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        bluebubbles: {
          groups: {
            "chat:primary": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
    } as any;

    expect(resolveBlueBubblesGroupRequireMention({ cfg, groupId: "chat:primary" })).toBe(false);
    expect(resolveBlueBubblesGroupRequireMention({ cfg, groupId: "chat:other" })).toBe(true);
    expect(resolveBlueBubblesGroupToolPolicy({ cfg, groupId: "chat:primary" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveBlueBubblesGroupToolPolicy({ cfg, groupId: "chat:other" })).toEqual({
      allow: ["message.send"],
    });
  });
});

describe("normalizeBlueBubblesMessagingTarget", () => {
  it("normalizes chat_guid targets", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:ABC-123")).toBe("chat_guid:ABC-123");
  });

  it("normalizes group numeric targets to chat_id", () => {
    expect(normalizeBlueBubblesMessagingTarget("group:123")).toBe("chat_id:123");
  });

  it("strips provider prefix and normalizes handles", () => {
    expect(normalizeBlueBubblesMessagingTarget("bluebubbles:imessage:User@Example.com")).toBe(
      "imessage:user@example.com",
    );
  });

  it("extracts handle from DM chat_guid for cross-context matching", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:iMessage;-;+19257864429")).toBe(
      "+19257864429",
    );
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:SMS;-;+15551234567")).toBe(
      "+15551234567",
    );
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:iMessage;-;user@example.com")).toBe(
      "user@example.com",
    );
  });

  it("preserves group chat_guid format", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat_guid:iMessage;+;chat123456789")).toBe(
      "chat_guid:iMessage;+;chat123456789",
    );
  });

  it("normalizes raw chat_guid values", () => {
    expect(normalizeBlueBubblesMessagingTarget("iMessage;+;chat660250192681427962")).toBe(
      "chat_guid:iMessage;+;chat660250192681427962",
    );
    expect(normalizeBlueBubblesMessagingTarget("iMessage;-;+19257864429")).toBe("+19257864429");
  });

  it("normalizes chat<digits> pattern to chat_identifier format", () => {
    expect(normalizeBlueBubblesMessagingTarget("chat660250192681427962")).toBe(
      "chat_identifier:chat660250192681427962",
    );
    expect(normalizeBlueBubblesMessagingTarget("chat123")).toBe("chat_identifier:chat123");
    expect(normalizeBlueBubblesMessagingTarget("Chat456789")).toBe("chat_identifier:Chat456789");
  });

  it("normalizes UUID/hex chat identifiers", () => {
    expect(normalizeBlueBubblesMessagingTarget("8b9c1a10536d4d86a336ea03ab7151cc")).toBe(
      "chat_identifier:8b9c1a10536d4d86a336ea03ab7151cc",
    );
    expect(normalizeBlueBubblesMessagingTarget("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toBe(
      "chat_identifier:1C2D3E4F-1234-5678-9ABC-DEF012345678",
    );
  });
});

describe("looksLikeBlueBubblesTargetId", () => {
  it("accepts chat targets", () => {
    expect(looksLikeBlueBubblesTargetId("chat_guid:ABC-123")).toBe(true);
  });

  it("accepts email handles", () => {
    expect(looksLikeBlueBubblesTargetId("user@example.com")).toBe(true);
  });

  it("accepts phone numbers with punctuation", () => {
    expect(looksLikeBlueBubblesTargetId("+1 (555) 123-4567")).toBe(true);
  });

  it("accepts raw chat_guid values", () => {
    expect(looksLikeBlueBubblesTargetId("iMessage;+;chat660250192681427962")).toBe(true);
  });

  it("accepts chat<digits> pattern as chat_id", () => {
    expect(looksLikeBlueBubblesTargetId("chat660250192681427962")).toBe(true);
    expect(looksLikeBlueBubblesTargetId("chat123")).toBe(true);
    expect(looksLikeBlueBubblesTargetId("Chat456789")).toBe(true);
  });

  it("accepts UUID/hex chat identifiers", () => {
    expect(looksLikeBlueBubblesTargetId("8b9c1a10536d4d86a336ea03ab7151cc")).toBe(true);
    expect(looksLikeBlueBubblesTargetId("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toBe(true);
  });

  it("rejects display names", () => {
    expect(looksLikeBlueBubblesTargetId("Jane Doe")).toBe(false);
  });
});

describe("looksLikeBlueBubblesExplicitTargetId", () => {
  it("treats explicit chat targets as immediate ids", () => {
    expect(looksLikeBlueBubblesExplicitTargetId("chat_guid:ABC-123")).toBe(true);
    expect(looksLikeBlueBubblesExplicitTargetId("imessage:+15551234567")).toBe(true);
  });

  it("prefers directory fallback for bare handles and phone numbers", () => {
    expect(looksLikeBlueBubblesExplicitTargetId("+1 (555) 123-4567")).toBe(false);
    expect(looksLikeBlueBubblesExplicitTargetId("user@example.com")).toBe(false);
  });
});

describe("inferBlueBubblesTargetChatType", () => {
  it("infers direct chat for handles and dm chat_guids", () => {
    expect(inferBlueBubblesTargetChatType("+15551234567")).toBe("direct");
    expect(inferBlueBubblesTargetChatType("chat_guid:iMessage;-;+15551234567")).toBe("direct");
  });

  it("infers group chat for explicit group targets", () => {
    expect(inferBlueBubblesTargetChatType("chat_id:123")).toBe("group");
    expect(inferBlueBubblesTargetChatType("chat_guid:iMessage;+;chat123")).toBe("group");
  });
});

describe("parseBlueBubblesTarget", () => {
  it("parses chat<digits> pattern as chat_identifier", () => {
    expect(parseBlueBubblesTarget("chat660250192681427962")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "chat660250192681427962",
    });
    expect(parseBlueBubblesTarget("chat123")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "chat123",
    });
    expect(parseBlueBubblesTarget("Chat456789")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "Chat456789",
    });
  });

  it("parses UUID/hex chat identifiers as chat_identifier", () => {
    expect(parseBlueBubblesTarget("8b9c1a10536d4d86a336ea03ab7151cc")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "8b9c1a10536d4d86a336ea03ab7151cc",
    });
    expect(parseBlueBubblesTarget("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "1C2D3E4F-1234-5678-9ABC-DEF012345678",
    });
  });

  it("parses explicit chat_id: prefix", () => {
    expect(parseBlueBubblesTarget("chat_id:123")).toEqual({ kind: "chat_id", chatId: 123 });
  });

  it("parses phone numbers as handles", () => {
    expect(parseBlueBubblesTarget("+19257864429")).toEqual({
      kind: "handle",
      to: "+19257864429",
      service: "auto",
    });
  });

  it("parses raw chat_guid format", () => {
    expect(parseBlueBubblesTarget("iMessage;+;chat660250192681427962")).toEqual({
      kind: "chat_guid",
      chatGuid: "iMessage;+;chat660250192681427962",
    });
  });
});

describe("parseBlueBubblesAllowTarget", () => {
  it("parses chat<digits> pattern as chat_identifier", () => {
    expect(parseBlueBubblesAllowTarget("chat660250192681427962")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "chat660250192681427962",
    });
    expect(parseBlueBubblesAllowTarget("chat123")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "chat123",
    });
  });

  it("parses UUID/hex chat identifiers as chat_identifier", () => {
    expect(parseBlueBubblesAllowTarget("8b9c1a10536d4d86a336ea03ab7151cc")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "8b9c1a10536d4d86a336ea03ab7151cc",
    });
    expect(parseBlueBubblesAllowTarget("1C2D3E4F-1234-5678-9ABC-DEF012345678")).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "1C2D3E4F-1234-5678-9ABC-DEF012345678",
    });
  });

  it("parses explicit chat_id: prefix", () => {
    expect(parseBlueBubblesAllowTarget("chat_id:456")).toEqual({ kind: "chat_id", chatId: 456 });
  });

  it("parses phone numbers as handles", () => {
    expect(parseBlueBubblesAllowTarget("+19257864429")).toEqual({
      kind: "handle",
      handle: "+19257864429",
    });
  });
});

describe("isAllowedBlueBubblesSender", () => {
  it("denies when allowFrom is empty", () => {
    const allowed = isAllowedBlueBubblesSender({
      allowFrom: [],
      sender: "+15551234567",
    });
    expect(allowed).toBe(false);
  });

  it("allows wildcard entries", () => {
    const allowed = isAllowedBlueBubblesSender({
      allowFrom: ["*"],
      sender: "+15551234567",
    });
    expect(allowed).toBe(true);
  });
});

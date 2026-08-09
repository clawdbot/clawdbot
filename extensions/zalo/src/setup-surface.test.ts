// Zalo tests cover setup surface plugin behavior.
import { adaptScopedAccountAccessor } from "openclaw/plugin-sdk/channel-config-helpers";
import { installChannelDmPolicyContractSuite } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { listZaloAccountIds, resolveDefaultZaloAccountId, resolveZaloAccount } from "./accounts.js";
import { zaloDmPolicy } from "./setup-core.js";
import { zaloSetupAdapter, zaloSetupWizard } from "./setup-surface.js";

const zaloSetupPlugin = {
  id: "zalo",
  meta: {
    id: "zalo",
    label: "Zalo",
    selectionLabel: "Zalo (Bot API)",
    docsPath: "/channels/zalo",
    blurb: "Vietnam-focused messaging platform with Bot API.",
  },
  capabilities: {
    chatTypes: ["direct", "group"] as Array<"direct" | "group">,
  },
  config: {
    listAccountIds: (cfg: unknown) => listZaloAccountIds(cfg as never),
    defaultAccountId: (cfg: unknown) => resolveDefaultZaloAccountId(cfg as never),
    resolveAccount: adaptScopedAccountAccessor(resolveZaloAccount),
  },
  setup: zaloSetupAdapter,
  setupWizard: zaloSetupWizard,
} as const;

const zaloConfigure = createPluginSetupWizardConfigure(zaloSetupPlugin);

describe("zalo setup wizard", () => {
  it("configures a polling token flow", async () => {
    const prompter = createTestWizardPrompter({
      select: vi.fn(async () => "plaintext") as WizardPrompter["select"],
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Zalo bot token") {
          return "12345689:abc-xyz";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Use webhook mode for Zalo?") {
          return false;
        }
        return false;
      }),
    });

    const result = await runSetupWizardConfigure({
      configure: zaloConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.accountId).toBe("default");
    const zaloConfig = result.cfg.channels?.zalo;
    if (!zaloConfig) {
      throw new Error("expected Zalo config");
    }
    expect(zaloConfig.enabled).toBe(true);
    expect(zaloConfig.botToken).toBe("12345689:abc-xyz");
    expect(zaloConfig.webhookUrl).toBeUndefined();
  });

  installChannelDmPolicyContractSuite({
    dmPolicy: zaloDmPolicy,
    cases: [
      {
        name: "Zalo named accounts",
        channel: "zalo",
        accountId: "work",
        accountConfig: { botToken: "12345689:abc-xyz" },
        inheritedAllowFrom: ["123456789"],
        defaultAccount: { rootAllowFrom: ["123456789"] },
      },
    ],
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await zaloSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          zalo: {
            defaultAccount: "work",
            botToken: "root-token",
            accounts: {
              alerts: {
                botToken: "alerts-token",
              },
              work: {
                botToken: "",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(false);
  });
});

import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import "./zalo-js.test-mocks.js";
import { zalouserSetupWizard } from "./setup-surface.js";
import { zalouserSetupPlugin } from "./setup-test-helpers.js";

const zalouserConfigure = createPluginSetupWizardConfigure(zalouserSetupPlugin);

async function runSetup(params: {
  cfg?: OpenClawConfig;
  prompter: ReturnType<typeof createTestWizardPrompter>;
  options?: Record<string, unknown>;
  forceAllowFrom?: boolean;
}) {
  return await runSetupWizardConfigure({
    configure: zalouserConfigure,
    cfg: params.cfg,
    prompter: params.prompter,
    options: params.options,
    forceAllowFrom: params.forceAllowFrom,
  });
}

describe("zalouser setup wizard", () => {
  function expectEnabledDefaultSetup(
    result: Awaited<ReturnType<typeof runSetup>>,
    dmPolicy?: "pairing" | "allowlist",
  ) {
    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
    if (dmPolicy) {
      expect(result.cfg.channels?.zalouser?.dmPolicy).toBe(dmPolicy);
    }
  }

  function createQuickstartPrompter(params?: {
    note?: ReturnType<typeof createTestWizardPrompter>["note"];
    seen?: string[];
    dmPolicy?: "pairing" | "allowlist";
    groupAccess?: boolean;
    groupPolicy?: "allowlist";
    textByMessage?: Record<string, string>;
  }) {
    const select = vi.fn(
      async ({ message, options }: { message: string; options: Array<{ value: string }> }) => {
        const first = options[0];
        if (!first) {
          throw new Error("no options");
        }
        params?.seen?.push(message);
        if (message === "Zalo Personal DM policy" && params?.dmPolicy) {
          return params.dmPolicy;
        }
        if (message === "Zalo groups access" && params?.groupPolicy) {
          return params.groupPolicy;
        }
        return first.value;
      },
    ) as ReturnType<typeof createTestWizardPrompter>["select"];
    const text = vi.fn(
      async ({ message }: { message: string }) => params?.textByMessage?.[message] ?? "",
    ) as ReturnType<typeof createTestWizardPrompter>["text"];
    return createTestWizardPrompter({
      ...(params?.note ? { note: params.note } : {}),
      confirm: vi.fn(async ({ message }: { message: string }) => {
        params?.seen?.push(message);
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return params?.groupAccess ?? false;
        }
        return false;
      }),
      select,
      text,
    });
  }

  it("enables the account without forcing QR login", async () => {
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return false;
        }
        return false;
      }),
    });

    const result = await runSetup({ prompter });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
  });

  it("prompts DM policy before group access in quickstart", async () => {
    const seen: string[] = [];
    const prompter = createQuickstartPrompter({ seen, dmPolicy: "pairing" });

    const result = await runSetup({
      prompter,
      options: { quickstartDefaults: true },
    });

    expectEnabledDefaultSetup(result, "pairing");
    expect(seen.indexOf("Zalo Personal DM policy")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("Configure Zalo groups access?")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("Zalo Personal DM policy")).toBeLessThan(
      seen.indexOf("Configure Zalo groups access?"),
    );
  });

  it("allows an empty quickstart DM allowlist with a warning", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createQuickstartPrompter({
      note,
      dmPolicy: "allowlist",
      textByMessage: {
        "Zalouser allowFrom (name or user id)": "",
      },
    });

    const result = await runSetup({
      prompter,
      options: { quickstartDefaults: true },
    });

    expectEnabledDefaultSetup(result, "allowlist");
    expect(result.cfg.channels?.zalouser?.allowFrom).toEqual([]);
    expect(
      note.mock.calls.some(([message]) => message.includes("No DM allowlist entries added yet.")),
    ).toBe(true);
  });

  it("allows an empty group allowlist with a warning", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createQuickstartPrompter({
      note,
      groupAccess: true,
      groupPolicy: "allowlist",
      textByMessage: {
        "Zalo groups allowlist (comma-separated)": "",
      },
    });

    const result = await runSetup({ prompter });

    expect(result.cfg.channels?.zalouser?.groupPolicy).toBe("allowlist");
    expect(result.cfg.channels?.zalouser?.groups).toEqual({});
    expect(
      note.mock.calls.some(([message]) =>
        message.includes("No group allowlist entries added yet."),
      ),
    ).toBe(true);
  });

  it("writes canonical enabled entries for configured groups", async () => {
    const prompter = createQuickstartPrompter({
      groupAccess: true,
      groupPolicy: "allowlist",
      textByMessage: {
        "Zalo groups allowlist (comma-separated)": "Family, Work",
      },
    });

    const result = await runSetup({ prompter });

    expect(result.cfg.channels?.zalouser?.groups).toEqual({
      Family: { enabled: true, requireMention: true },
      Work: { enabled: true, requireMention: true },
    });
  });

  it("preserves non-quickstart forceAllowFrom behavior", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const seen: string[] = [];
    const prompter = createTestWizardPrompter({
      note,
      confirm: vi.fn(async ({ message }: { message: string }) => {
        seen.push(message);
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return false;
        }
        return false;
      }),
      text: vi.fn(async ({ message }: { message: string }) => {
        seen.push(message);
        if (message === "Zalouser allowFrom (name or user id)") {
          return "";
        }
        return "";
      }) as ReturnType<typeof createTestWizardPrompter>["text"],
    });

    const result = await runSetup({ prompter, forceAllowFrom: true });

    expect(result.cfg.channels?.zalouser?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.zalouser?.allowFrom).toEqual([]);
    expect(seen).not.toContain("Zalo Personal DM policy");
    expect(seen).toContain("Zalouser allowFrom (name or user id)");
    expect(
      note.mock.calls.some(([message]) => message.includes("No DM allowlist entries added yet.")),
    ).toBe(true);
  });

  it("allowlists the plugin when a plugin allowlist already exists", async () => {
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return false;
        }
        return false;
      }),
    });

    const result = await runSetup({
      cfg: {
        plugins: {
          allow: ["telegram"],
        },
      } as OpenClawConfig,
      prompter,
    });

    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["telegram", "zalouser"]);
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      zalouserSetupWizard.dmPolicy?.getCurrent(
        {
          channels: {
            zalouser: {
              dmPolicy: "disabled",
              accounts: {
                work: {
                  profile: "work",
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        } as OpenClawConfig,
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(zalouserSetupWizard.dmPolicy?.resolveConfigKeys?.({} as OpenClawConfig, "work")).toEqual(
      {
        policyKey: "channels.zalouser.accounts.work.dmPolicy",
        allowFromKey: "channels.zalouser.accounts.work.allowFrom",
      },
    );
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg = {
      channels: {
        zalouser: {
          defaultAccount: "work",
          dmPolicy: "disabled",
          allowFrom: ["123456789"],
          accounts: {
            work: {
              dmPolicy: "allowlist",
              profile: "work-profile",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(zalouserSetupWizard.dmPolicy?.getCurrent(cfg)).toBe("allowlist");
    expect(zalouserSetupWizard.dmPolicy?.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.zalouser.accounts.work.dmPolicy",
      allowFromKey: "channels.zalouser.accounts.work.allowFrom",
    });

    const next = zalouserSetupWizard.dmPolicy?.setPolicy(cfg, "open");
    expect(next?.channels?.zalouser?.dmPolicy).toBe("disabled");
    const workAccount = next?.channels?.zalouser?.accounts?.work as
      | { dmPolicy?: string; allowFrom?: Array<string | number> }
      | undefined;
    expect(workAccount?.dmPolicy).toBe("open");
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', () => {
    const next = zalouserSetupWizard.dmPolicy?.setPolicy(
      {
        channels: {
          zalouser: {
            allowFrom: ["123456789"],
            accounts: {
              work: {
                profile: "work",
              },
            },
          },
        },
      } as OpenClawConfig,
      "open",
      "work",
    );

    expect(next?.channels?.zalouser?.dmPolicy).toBeUndefined();
    const workAccount = next?.channels?.zalouser?.accounts?.work as
      | { dmPolicy?: string; allowFrom?: Array<string | number> }
      | undefined;
    expect(workAccount?.dmPolicy).toBe("open");
    expect(workAccount?.allowFrom).toEqual(["123456789", "*"]);
  });

  it("shows the account-scoped current DM policy in quickstart notes", async () => {
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createQuickstartPrompter({ note, dmPolicy: "pairing" });

    await runSetupWizardConfigure({
      configure: zalouserConfigure,
      cfg: {
        channels: {
          zalouser: {
            dmPolicy: "disabled",
            accounts: {
              work: {
                profile: "work",
                dmPolicy: "allowlist",
                allowFrom: ["123456789"],
              },
            },
          },
        },
      } as OpenClawConfig,
      prompter,
      options: { quickstartDefaults: true },
      accountOverrides: { zalouser: "work" },
    });

    expect(
      note.mock.calls.some(([message]) =>
        message.includes("Current: dmPolicy=allowlist, allowFrom=123456789"),
      ),
    ).toBe(true);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import {
  clearNextcloudTalkAccountFields,
  nextcloudTalkDmPolicy,
  nextcloudTalkSetupAdapter,
  normalizeNextcloudTalkBaseUrl,
  setNextcloudTalkAccountConfig,
  validateNextcloudTalkBaseUrl,
} from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

describe("nextcloud talk setup", () => {
  it("normalizes and validates base urls", () => {
    expect(normalizeNextcloudTalkBaseUrl(" https://cloud.example.com/// ")).toBe(
      "https://cloud.example.com",
    );
    expect(normalizeNextcloudTalkBaseUrl(undefined)).toBe("");

    expect(validateNextcloudTalkBaseUrl("")).toBe("Required");
    expect(validateNextcloudTalkBaseUrl("cloud.example.com")).toBe(
      "URL must start with http:// or https://",
    );
    expect(validateNextcloudTalkBaseUrl("https://cloud.example.com")).toBeUndefined();
  });

  it("patches scoped account config and clears selected fields", () => {
    const cfg: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "top-secret",
          accounts: {
            work: {
              botSecret: "work-secret",
              botSecretFile: "/tmp/work-secret",
              apiPassword: "api-secret",
            },
          },
        },
      },
    };

    expect(
      setNextcloudTalkAccountConfig(cfg, DEFAULT_ACCOUNT_ID, {
        apiUser: "bot",
      }),
    ).toMatchObject({
      channels: {
        "nextcloud-talk": {
          apiUser: "bot",
        },
      },
    });

    expect(clearNextcloudTalkAccountFields(cfg, DEFAULT_ACCOUNT_ID, ["botSecret"])).toMatchObject({
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
        },
      },
    });
    expect(
      clearNextcloudTalkAccountFields(cfg, DEFAULT_ACCOUNT_ID, ["botSecret"]),
    ).not.toMatchObject({
      channels: {
        "nextcloud-talk": {
          botSecret: expect.anything(),
        },
      },
    });

    expect(
      clearNextcloudTalkAccountFields(cfg, "work", ["botSecret", "botSecretFile"]),
    ).toMatchObject({
      channels: {
        "nextcloud-talk": {
          accounts: {
            work: {
              apiPassword: "api-secret",
            },
          },
        },
      },
    });
  });

  it("sets top-level DM policy state", async () => {
    const base: CoreConfig = {
      channels: {
        "nextcloud-talk": {},
      },
    };

    expect(nextcloudTalkDmPolicy.getCurrent(base)).toBe("pairing");
    expect(nextcloudTalkDmPolicy.setPolicy(base, "open")).toMatchObject({
      channels: {
        "nextcloud-talk": {
          dmPolicy: "open",
        },
      },
    });
  });

  it("honors named-account DM policy state and config keys", () => {
    const base: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          dmPolicy: "disabled",
          accounts: {
            work: {
              baseUrl: "https://cloud.example.com",
              botSecret: "work-secret",
              dmPolicy: "allowlist",
            },
          },
        },
      },
    };

    expect(nextcloudTalkDmPolicy.getCurrent(base, "work")).toBe("allowlist");
    expect(nextcloudTalkDmPolicy.resolveConfigKeys?.(base, "work")).toEqual({
      policyKey: "channels.nextcloud-talk.accounts.work.dmPolicy",
      allowFromKey: "channels.nextcloud-talk.accounts.work.allowFrom",
    });
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const base: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          defaultAccount: "work",
          dmPolicy: "disabled",
          accounts: {
            work: {
              baseUrl: "https://cloud.example.com",
              botSecret: "work-secret",
              dmPolicy: "allowlist",
            },
          },
        },
      },
    };

    expect(nextcloudTalkDmPolicy.getCurrent(base)).toBe("allowlist");
    expect(nextcloudTalkDmPolicy.resolveConfigKeys?.(base)).toEqual({
      policyKey: "channels.nextcloud-talk.accounts.work.dmPolicy",
      allowFromKey: "channels.nextcloud-talk.accounts.work.allowFrom",
    });

    const next = nextcloudTalkDmPolicy.setPolicy(base, "open");
    expect(next.channels?.["nextcloud-talk"]?.dmPolicy).toBe("disabled");
    const workAccount = next.channels?.["nextcloud-talk"]?.accounts?.work as
      | { dmPolicy?: string; allowFrom?: Array<string | number> }
      | undefined;
    expect(workAccount?.dmPolicy).toBe("open");
  });

  it('writes open DM policy to the named account and preserves inherited allowFrom with "*"', () => {
    const next = nextcloudTalkDmPolicy.setPolicy(
      {
        channels: {
          "nextcloud-talk": {
            allowFrom: ["alice"],
            accounts: {
              work: {
                baseUrl: "https://cloud.example.com",
                botSecret: "work-secret",
              },
            },
          },
        },
      },
      "open",
      "work",
    );

    expect(next.channels?.["nextcloud-talk"]?.dmPolicy).toBeUndefined();
    const workAccount = next.channels?.["nextcloud-talk"]?.accounts?.work as
      | { dmPolicy?: string; allowFrom?: Array<string | number> }
      | undefined;
    expect(workAccount?.dmPolicy).toBe("open");
    expect(workAccount?.allowFrom).toEqual(["alice", "*"]);
  });

  it("validates env/default-account constraints and applies config patches", () => {
    const validateInput = nextcloudTalkSetupAdapter.validateInput;
    const applyAccountConfig = nextcloudTalkSetupAdapter.applyAccountConfig;
    expect(validateInput).toBeTypeOf("function");
    expect(applyAccountConfig).toBeTypeOf("function");

    expect(
      validateInput!({
        accountId: "work",
        input: { useEnv: true },
      } as never),
    ).toBe("NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.");

    expect(
      validateInput!({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, baseUrl: "", secret: "" },
      } as never),
    ).toBe("Nextcloud Talk requires bot secret or --secret-file (or --use-env).");

    expect(
      validateInput!({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, secret: "secret", baseUrl: "" },
      } as never),
    ).toBe("Nextcloud Talk requires --base-url.");

    expect(
      applyAccountConfig({
        cfg: {
          channels: {
            "nextcloud-talk": {},
          },
        },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          baseUrl: "https://cloud.example.com///",
          secret: "bot-secret",
        },
      } as never),
    ).toEqual({
      channels: {
        "nextcloud-talk": {
          enabled: true,
          name: "Default",
          baseUrl: "https://cloud.example.com",
          botSecret: "bot-secret",
        },
      },
    });

    expect(
      applyAccountConfig({
        cfg: {
          channels: {
            "nextcloud-talk": {
              accounts: {
                work: {
                  botSecret: "old-secret",
                },
              },
            },
          },
        },
        accountId: "work",
        input: {
          name: "Work",
          useEnv: true,
          baseUrl: "https://cloud.example.com",
        },
      } as never),
    ).toMatchObject({
      channels: {
        "nextcloud-talk": {
          accounts: {
            work: {
              enabled: true,
              name: "Work",
              baseUrl: "https://cloud.example.com",
            },
          },
        },
      },
    });
  });

  it("clears stored bot secret fields when switching the default account to env", () => {
    type ApplyAccountConfigContext = Parameters<
      typeof nextcloudTalkSetupAdapter.applyAccountConfig
    >[0];

    const next = nextcloudTalkSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          "nextcloud-talk": {
            enabled: true,
            baseUrl: "https://cloud.old.example",
            botSecret: "stored-secret",
            botSecretFile: "/tmp/secret.txt",
          },
        },
      },
      accountId: DEFAULT_ACCOUNT_ID,
      input: {
        baseUrl: "https://cloud.example.com",
        useEnv: true,
      },
    } as unknown as ApplyAccountConfigContext);

    expect(next.channels?.["nextcloud-talk"]?.baseUrl).toBe("https://cloud.example.com");
    expect(next.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecret");
    expect(next.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecretFile");
  });

  it("clears stored bot secret fields when the wizard switches to env", async () => {
    const credential = nextcloudTalkSetupWizard.credentials[0];
    const next = await credential.applyUseEnv?.({
      cfg: {
        channels: {
          "nextcloud-talk": {
            enabled: true,
            baseUrl: "https://cloud.example.com",
            botSecret: "stored-secret",
            botSecretFile: "/tmp/secret.txt",
          },
        },
      },
      accountId: DEFAULT_ACCOUNT_ID,
    });

    expect(next?.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecret");
    expect(next?.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecretFile");
  });
});

describe("resolveNextcloudTalkAccount", () => {
  it("matches normalized configured account ids", () => {
    const account = resolveNextcloudTalkAccount({
      cfg: {
        channels: {
          "nextcloud-talk": {
            accounts: {
              "Ops Team": {
                baseUrl: "https://cloud.example.com",
                botSecret: "bot-secret",
              },
            },
          },
        },
      } as CoreConfig,
      accountId: "ops-team",
    });

    expect(account.accountId).toBe("ops-team");
    expect(account.baseUrl).toBe("https://cloud.example.com");
    expect(account.secret).toBe("bot-secret");
    expect(account.secretSource).toBe("config");
  });

  it.runIf(process.platform !== "win32")("rejects symlinked botSecretFile paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-nextcloud-talk-"));
    const secretFile = path.join(dir, "secret.txt");
    const secretLink = path.join(dir, "secret-link.txt");
    fs.writeFileSync(secretFile, "bot-secret\n", "utf8");
    fs.symlinkSync(secretFile, secretLink);

    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecretFile: secretLink,
        },
      },
    } as CoreConfig;

    const account = resolveNextcloudTalkAccount({ cfg });
    expect(account.secret).toBe("");
    expect(account.secretSource).toBe("none");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const account = resolveNextcloudTalkAccount({
      cfg: {
        channels: {
          "nextcloud-talk": {
            defaultAccount: "work",
            botSecret: "top-secret",
            accounts: {
              work: {
                baseUrl: "https://cloud.example.com",
                botSecret: "work-secret",
              },
            },
          },
        },
      } as CoreConfig,
    });

    expect(account.accountId).toBe("work");
    expect(account.baseUrl).toBe("https://cloud.example.com");
    expect(account.secret).toBe("work-secret");
    expect(account.secretSource).toBe("config");
  });

  it("uses configured defaultAccount for omitted setup configured state", () => {
    const configured = nextcloudTalkSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          "nextcloud-talk": {
            defaultAccount: "work",
            baseUrl: "https://root.example.com",
            botSecret: "root-secret",
            accounts: {
              alerts: {
                baseUrl: "https://alerts.example.com",
                botSecret: "alerts-secret",
              },
              work: {
                baseUrl: "",
                botSecret: "",
              },
            },
          },
        },
      } as CoreConfig,
    });

    expect(configured).toBe(false);
  });
});

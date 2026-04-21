import { describe, expect, it } from "vitest";
import { SlackConfigSchema } from "../config-api.js";

function expectSlackConfigValid(config: unknown) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
}

function expectSlackConfigIssue(config: unknown, path: string) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues.some((issue) => issue.path.join(".").includes(path))).toBe(true);
  }
}

describe("slack config schema", () => {
  it("defaults groupPolicy to allowlist", () => {
    const res = SlackConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("accepts historyLimit overrides per account", () => {
    const res = SlackConfigSchema.safeParse({
      historyLimit: 7,
      accounts: { ops: { historyLimit: 2 } },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(7);
      expect(res.data.accounts?.ops?.historyLimit).toBe(2);
    }
  });

  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    expectSlackConfigIssue(
      {
        dmPolicy: "open",
        allowFrom: ["U123"],
      },
      "allowFrom",
    );
  });

  it('accepts legacy dm.policy="open" with top-level allowFrom alias', () => {
    expectSlackConfigValid({
      dm: { policy: "open", allowFrom: ["U123"] },
      allowFrom: ["*"],
    });
  });

  it("accepts user token config fields", () => {
    expectSlackConfigValid({
      botToken: "xoxb-any",
      appToken: "xapp-any",
      userToken: "xoxp-any",
      userTokenReadOnly: false,
    });
  });

  it("accepts account-level user token config", () => {
    expectSlackConfigValid({
      accounts: {
        work: {
          botToken: "xoxb-any",
          appToken: "xapp-any",
          userToken: "xoxp-any",
          userTokenReadOnly: true,
        },
      },
    });
  });

  it("rejects invalid userTokenReadOnly types", () => {
    expectSlackConfigIssue(
      {
        botToken: "xoxb-any",
        appToken: "xapp-any",
        userToken: "xoxp-any",
        userTokenReadOnly: "no",
      },
      "userTokenReadOnly",
    );
  });

  it("rejects invalid userToken types", () => {
    expectSlackConfigIssue(
      {
        botToken: "xoxb-any",
        appToken: "xapp-any",
        userToken: 123,
      },
      "userToken",
    );
  });

  it("accepts HTTP mode when signing secret is configured", () => {
    expectSlackConfigValid({
      mode: "http",
      signingSecret: "secret",
    });
  });

  it("accepts HTTP mode when signing secret is configured as SecretRef", () => {
    expectSlackConfigValid({
      mode: "http",
      signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
    });
  });

  it("rejects HTTP mode without signing secret", () => {
    expectSlackConfigIssue({ mode: "http" }, "signingSecret");
  });

  it("accepts account HTTP mode when base signing secret is set", () => {
    expectSlackConfigValid({
      signingSecret: "secret",
      accounts: {
        ops: {
          mode: "http",
        },
      },
    });
  });

  it("accepts account HTTP mode when account signing secret is set as SecretRef", () => {
    expectSlackConfigValid({
      accounts: {
        ops: {
          mode: "http",
          signingSecret: {
            source: "env",
            provider: "default",
            id: "SLACK_OPS_SIGNING_SECRET",
          },
        },
      },
    });
  });

  it("rejects account HTTP mode without signing secret", () => {
    expectSlackConfigIssue(
      {
        accounts: {
          ops: {
            mode: "http",
          },
        },
      },
      "accounts.ops.signingSecret",
    );
  });
});

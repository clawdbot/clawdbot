import { describe, expect, it } from "vitest";
import { SlackConfigSchema } from "./zod-schema.providers-core.js";

function expectSlackConfigValid(config: unknown) {
  expect(SlackConfigSchema.safeParse(config).success).toBe(true);
}

function expectSlackConfigIssue(config: unknown, path: string) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues.some((issue) => issue.path.join(".").includes(path))).toBe(true);
  }
}

describe("channel token and HTTP validation", () => {
  describe("Slack token fields", () => {
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
  });

  describe("Slack HTTP mode", () => {
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
});

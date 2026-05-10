import { describe, expect, it } from "vitest";
import "./runtime-channel-inactive-variants.test-support.ts";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("secrets runtime snapshot channel inactive variants", () => {
  it("treats IRC account nickserv password refs as inactive when nickserv is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          irc: {
            accounts: {
              work: {
                enabled: true,
                nickserv: {
                  enabled: false,
                  password: {
                    source: "env",
                    provider: "default",
                    id: "MISSING_IRC_WORK_NICKSERV_PASSWORD",
                  },
                },
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.irc?.accounts?.work?.nickserv?.password).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_IRC_WORK_NICKSERV_PASSWORD",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.irc.accounts.work.nickserv.password",
    );
  });

  it("treats top-level IRC nickserv password refs as inactive when nickserv is disabled", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          irc: {
            nickserv: {
              enabled: false,
              password: {
                source: "env",
                provider: "default",
                id: "MISSING_IRC_TOPLEVEL_NICKSERV_PASSWORD",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.irc?.nickserv?.password).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_IRC_TOPLEVEL_NICKSERV_PASSWORD",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.irc.nickserv.password",
    );
  });

  it("treats Slack signingSecret refs as inactive when mode is socket", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          slack: {
            mode: "socket",
            signingSecret: {
              source: "env",
              provider: "default",
              id: "MISSING_SLACK_SIGNING_SECRET",
            },
            accounts: {
              work: {
                enabled: true,
                mode: "socket",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.slack?.signingSecret).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_SLACK_SIGNING_SECRET",
    });
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.slack.signingSecret",
    );
  });

  it("treats Slack appToken refs as inactive when mode is http", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          slack: {
            mode: "http",
            appToken: {
              source: "env",
              provider: "default",
              id: "MISSING_SLACK_APP_TOKEN",
            },
            accounts: {
              work: {
                enabled: true,
                mode: "http",
                appToken: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_SLACK_WORK_APP_TOKEN",
                },
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.slack?.appToken).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_SLACK_APP_TOKEN",
    });
    expect(snapshot.config.channels?.slack?.accounts?.work?.appToken).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_SLACK_WORK_APP_TOKEN",
    });
    const warningPaths = snapshot.warnings.map((warning) => warning.path);
    expect(warningPaths).toContain("channels.slack.appToken");
    expect(warningPaths).toContain("channels.slack.accounts.work.appToken");
  });

  it("treats top-level Google Chat serviceAccount as inactive when enabled accounts use serviceAccountRef", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          googlechat: {
            serviceAccount: {
              source: "env",
              provider: "default",
              id: "MISSING_GOOGLECHAT_BASE_SERVICE_ACCOUNT",
            },
            accounts: {
              work: {
                enabled: true,
                serviceAccountRef: {
                  source: "env",
                  provider: "default",
                  id: "GOOGLECHAT_WORK_SERVICE_ACCOUNT",
                },
              },
            },
          },
        },
      }),
      env: {
        GOOGLECHAT_WORK_SERVICE_ACCOUNT: "work-service-account-json",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.googlechat?.serviceAccount).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_GOOGLECHAT_BASE_SERVICE_ACCOUNT",
    });
    expect(snapshot.config.channels?.googlechat?.accounts?.work?.serviceAccount).toBe(
      "work-service-account-json",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.googlechat.serviceAccount",
    );
  });
});

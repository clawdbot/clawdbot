/** Tests LINE credential inheritance in secrets runtime collection. */
import { describe, expect, it } from "vitest";
import "./runtime-line.test-support.ts";
import {
  asConfig,
  loadAuthStoreWithProfiles,
  setupSecretsRuntimeSnapshotTestHooks,
} from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

const envRef = (id: string) => ({ source: "env", provider: "default", id }) as const;

describe("secrets runtime snapshot line credential inheritance", () => {
  it("resolves channel-level credentials for the default account the accounts map never names", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          line: {
            channelAccessToken: envRef("LINE_ROOT_TOKEN"),
            channelSecret: envRef("LINE_ROOT_SECRET"),
            accounts: {
              work: {
                channelAccessToken: envRef("LINE_WORK_TOKEN"),
                channelSecret: envRef("LINE_WORK_SECRET"),
              },
            },
          },
        },
      }),
      env: {
        LINE_ROOT_TOKEN: "line-root-token",
        LINE_ROOT_SECRET: "line-root-secret",
        LINE_WORK_TOKEN: "line-work-token",
        LINE_WORK_SECRET: "line-work-secret",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.line?.channelAccessToken).toBe("line-root-token");
    expect(snapshot.config.channels?.line?.channelSecret).toBe("line-root-secret");
    expect(snapshot.config.channels?.line?.accounts?.work?.channelAccessToken).toBe(
      "line-work-token",
    );
    expect(snapshot.warnings.map((warning) => warning.path)).not.toContain(
      "channels.line.channelAccessToken",
    );
  });

  it("leaves channel-level credentials unresolved when accounts.default supplies its own", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          line: {
            channelAccessToken: envRef("UNUSED_LINE_ROOT_TOKEN"),
            accounts: {
              default: {
                channelAccessToken: envRef("LINE_DEFAULT_TOKEN"),
              },
            },
          },
        },
      }),
      env: { LINE_DEFAULT_TOKEN: "line-default-token" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.line?.accounts?.default?.channelAccessToken).toBe(
      "line-default-token",
    );
    expect(snapshot.config.channels?.line?.channelAccessToken).toEqual(
      envRef("UNUSED_LINE_ROOT_TOKEN"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.line.channelAccessToken",
    );
  });

  it("leaves a channel-level signing secret unresolved when no default account is admitted", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        channels: {
          line: {
            channelSecret: envRef("UNUSED_LINE_ROOT_SECRET"),
            accounts: {
              work: {
                channelAccessToken: "line-work-token",
                channelSecret: "line-work-secret",
              },
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => loadAuthStoreWithProfiles({}),
    });

    expect(snapshot.config.channels?.line?.channelSecret).toEqual(
      envRef("UNUSED_LINE_ROOT_SECRET"),
    );
    expect(snapshot.warnings.map((warning) => warning.path)).toContain(
      "channels.line.channelSecret",
    );
  });
});

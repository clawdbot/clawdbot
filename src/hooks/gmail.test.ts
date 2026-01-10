import { describe, expect, it } from "vitest";
import { type ClawdbotConfig, DEFAULT_GATEWAY_PORT } from "../config/config.js";
import {
  buildDefaultHookUrl,
  buildTopicPath,
  parseTopicPath,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";

const baseConfig = {
  hooks: {
    token: "hook-token",
    gmail: {
      account: "clawdbot@gmail.com",
      topic: "projects/demo/topics/gog-gmail-watch",
      pushToken: "push-token",
    },
  },
} satisfies ClawdbotConfig;

describe("gmail hook config", () => {
  it("builds default hook url", () => {
    expect(buildDefaultHookUrl("/hooks", DEFAULT_GATEWAY_PORT)).toBe(
      `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`,
    );
  });

  it("parses topic path", () => {
    const topic = buildTopicPath("proj", "topic");
    expect(parseTopicPath(topic)).toEqual({
      projectId: "proj",
      topicName: "topic",
    });
  });

  it("resolves runtime config with defaults", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.account).toBe("clawdbot@gmail.com");
      expect(result.value.label).toBe("INBOX");
      expect(result.value.includeBody).toBe(true);
      expect(result.value.serve.port).toBe(8788);
      expect(result.value.hookUrl).toBe(
        `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`,
      );
    }
  });

  it("fails without hook token", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          gmail: {
            account: "clawdbot@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(false);
  });

  it("defaults serve path to / when tailscale is enabled", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "clawdbot@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
            tailscale: { mode: "funnel" },
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serve.path).toBe("/");
      expect(result.value.tailscale.path).toBe("/gmail-pubsub");
    }
  });

  it("keeps the default public path when serve path is explicit", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "clawdbot@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
            serve: { path: "/gmail-pubsub" },
            tailscale: { mode: "funnel" },
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serve.path).toBe("/");
      expect(result.value.tailscale.path).toBe("/gmail-pubsub");
    }
  });

  it("keeps custom public path when serve path is set", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "clawdbot@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
            serve: { path: "/custom" },
            tailscale: { mode: "funnel" },
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serve.path).toBe("/");
      expect(result.value.tailscale.path).toBe("/custom");
    }
  });

  it("keeps serve path when tailscale target is set", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "clawdbot@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
            serve: { path: "/custom" },
            tailscale: {
              mode: "funnel",
              target: "http://127.0.0.1:8788/custom",
            },
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serve.path).toBe("/custom");
      expect(result.value.tailscale.path).toBe("/custom");
      expect(result.value.tailscale.target).toBe(
        "http://127.0.0.1:8788/custom",
      );
    }
  });
});

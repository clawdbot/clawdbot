import { describe, expect, it } from "vitest";
import { resolveWebhooksPluginConfig } from "./config.js";

describe("resolveWebhooksPluginConfig", () => {
  it("keeps SecretRef-backed secrets on the route config", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          zapier: {
            sessionKey: "agent:main:main",
            secret: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_WEBHOOK_SECRET",
            },
          },
        },
      },
    });

    expect(routes).toEqual([
      {
        routeId: "zapier",
        path: "/plugins/webhooks/zapier",
        sessionKey: "agent:main:main",
        secret: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_WEBHOOK_SECRET",
        },
        controllerId: "webhooks/zapier",
      },
    ]);
  });

  it("keeps routes whose secret needs runtime resolution", () => {
    const routes = resolveWebhooksPluginConfig({
      pluginConfig: {
        routes: {
          missing: {
            sessionKey: "agent:main:main",
            secret: {
              source: "env",
              provider: "default",
              id: "MISSING_SECRET",
            },
          },
        },
      },
    });

    expect(routes).toEqual([
      {
        routeId: "missing",
        path: "/plugins/webhooks/missing",
        sessionKey: "agent:main:main",
        secret: {
          source: "env",
          provider: "default",
          id: "MISSING_SECRET",
        },
        controllerId: "webhooks/missing",
      },
    ]);
  });

  it("rejects duplicate normalized paths", () => {
    expect(() =>
      resolveWebhooksPluginConfig({
        pluginConfig: {
          routes: {
            first: {
              path: "/plugins/webhooks/shared",
              sessionKey: "agent:main:main",
              secret: "a",
            },
            second: {
              path: "/plugins/webhooks/shared/",
              sessionKey: "agent:main:other",
              secret: "b",
            },
          },
        },
      }),
    ).toThrow(/conflicts with routes\.first\.path/i);
  });
});

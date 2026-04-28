import { describe, expect, it } from "vitest";
import { resolveGatewayStartupMaintenanceConfig } from "./server-startup-plugins.js";

describe("gateway startup channel maintenance wiring", () => {
  it("uses channels from the resolved startup config when startup config repaired them", () => {
    const resolved = resolveGatewayStartupMaintenanceConfig({
      cfgAtStart: {
        plugins: { enabled: true },
      },
      startupRuntimeConfig: {
        plugins: { enabled: true },
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-123",
          },
        },
      },
    });

    expect(resolved.channels).toEqual({
      matrix: {
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "tok-123",
      },
    });
  });

  it("preserves explicit startup channel config", () => {
    const resolved = resolveGatewayStartupMaintenanceConfig({
      cfgAtStart: {
        plugins: { enabled: true },
        channels: {
          matrix: {
            homeserver: "https://matrix.original.example",
            userId: "@original:example.org",
            accessToken: "original-token",
          },
        },
      },
      startupRuntimeConfig: {
        plugins: { enabled: true },
        channels: {
          matrix: {
            homeserver: "https://matrix.repaired.example",
            userId: "@repaired:example.org",
            accessToken: "repaired-token",
          },
        },
      },
    });

    expect(resolved.channels?.matrix).toEqual({
      homeserver: "https://matrix.original.example",
      userId: "@original:example.org",
      accessToken: "original-token",
    });
  });
});

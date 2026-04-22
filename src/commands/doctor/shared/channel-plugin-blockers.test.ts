import { beforeEach, describe, expect, it, vi } from "vitest";
import * as manifestRegistry from "../../../plugins/manifest-registry.js";
import { scanConfiguredChannelPluginBlockers } from "./channel-plugin-blockers.js";

describe("channel plugin blockers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips plugin registry work when config has no plugin blocker surfaces", () => {
    const registrySpy = vi.spyOn(manifestRegistry, "loadPluginManifestRegistry");

    const hits = scanConfiguredChannelPluginBlockers({
      channels: {
        slack: {
          accounts: {
            work: {
              allowFrom: ["alice"],
            },
          },
        },
      },
    });

    expect(hits).toEqual([]);
    expect(registrySpy).not.toHaveBeenCalled();
  });

  it("still evaluates configured channels when plugins are disabled globally", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "slack",
          origin: "bundled",
          channels: ["slack"],
          enabledByDefault: true,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers({
      plugins: {
        enabled: false,
      },
      channels: {
        slack: {
          accounts: {
            work: {
              allowFrom: ["alice"],
            },
          },
        },
      },
    });

    expect(hits).toEqual([
      {
        channelId: "slack",
        pluginId: "slack",
        reason: "plugins disabled",
      },
    ]);
  });

  it("ignores ambient channel env when reporting plugin blockers", () => {
    vi.spyOn(manifestRegistry, "loadPluginManifestRegistry").mockReturnValue({
      plugins: [
        {
          id: "slack",
          origin: "bundled",
          channels: ["slack"],
          enabledByDefault: true,
        },
        {
          id: "telegram",
          origin: "bundled",
          channels: ["telegram"],
          enabledByDefault: true,
        },
      ],
      diagnostics: [],
    } as unknown as ReturnType<typeof manifestRegistry.loadPluginManifestRegistry>);

    const hits = scanConfiguredChannelPluginBlockers(
      {
        plugins: {
          enabled: false,
        },
        channels: {
          telegram: {
            botToken: "configured",
          },
        },
      },
      {
        SLACK_BOT_TOKEN: "ambient",
      } as NodeJS.ProcessEnv,
    );

    expect(hits).toEqual([
      {
        channelId: "telegram",
        pluginId: "telegram",
        reason: "plugins disabled",
      },
    ]);
  });
});

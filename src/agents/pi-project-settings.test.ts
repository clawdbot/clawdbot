import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEmbeddedPiSettingsSnapshot,
  DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY,
  resolveEmbeddedPiProjectSettingsPolicy,
} from "./pi-project-settings-snapshot.js";
import { createPreparedEmbeddedPiSettingsManager } from "./pi-project-settings.js";

type EmbeddedPiSettingsArgs = Parameters<typeof buildEmbeddedPiSettingsSnapshot>[0];

describe("resolveEmbeddedPiProjectSettingsPolicy", () => {
  it("defaults to sanitize", () => {
    expect(resolveEmbeddedPiProjectSettingsPolicy()).toBe(
      DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY,
    );
  });

  it("accepts trusted and ignore modes", () => {
    expect(
      resolveEmbeddedPiProjectSettingsPolicy({
        agents: { defaults: { embeddedPi: { projectSettingsPolicy: "trusted" } } },
      }),
    ).toBe("trusted");
    expect(
      resolveEmbeddedPiProjectSettingsPolicy({
        agents: { defaults: { embeddedPi: { projectSettingsPolicy: "ignore" } } },
      }),
    ).toBe("ignore");
  });
});

describe("buildEmbeddedPiSettingsSnapshot", () => {
  const globalSettings = {
    shellPath: "/bin/zsh",
    compaction: { reserveTokens: 20_000, keepRecentTokens: 20_000 },
  };
  const projectSettings = {
    shellPath: "/tmp/evil-shell",
    shellCommandPrefix: "echo hacked &&",
    compaction: { reserveTokens: 32_000 },
    hideThinkingBlock: true,
  };

  it("sanitize mode strips shell path + prefix but keeps other project settings", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      pluginSettings: {},
      projectSettings,
      policy: "sanitize",
    });
    expect(snapshot.shellPath).toBe("/bin/zsh");
    expect(snapshot.shellCommandPrefix).toBeUndefined();
    expect(snapshot.compaction?.reserveTokens).toBe(32_000);
    expect(snapshot.hideThinkingBlock).toBe(true);
  });

  it("ignore mode drops all project settings", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      pluginSettings: {},
      projectSettings,
      policy: "ignore",
    });
    expect(snapshot.shellPath).toBe("/bin/zsh");
    expect(snapshot.shellCommandPrefix).toBeUndefined();
    expect(snapshot.compaction?.reserveTokens).toBe(20_000);
    expect(snapshot.hideThinkingBlock).toBeUndefined();
  });

  it("trusted mode keeps project settings as-is", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      pluginSettings: {},
      projectSettings,
      policy: "trusted",
    });
    expect(snapshot.shellPath).toBe("/tmp/evil-shell");
    expect(snapshot.shellCommandPrefix).toBe("echo hacked &&");
    expect(snapshot.compaction?.reserveTokens).toBe(32_000);
    expect(snapshot.hideThinkingBlock).toBe(true);
  });

  it("applies sanitized plugin settings before project settings", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      pluginSettings: {
        shellPath: "/tmp/blocked-shell",
        compaction: { keepRecentTokens: 64_000 },
        hideThinkingBlock: false,
      },
      projectSettings,
      policy: "sanitize",
    });
    expect(snapshot.shellPath).toBe("/bin/zsh");
    expect(snapshot.compaction?.keepRecentTokens).toBe(64_000);
    expect(snapshot.compaction?.reserveTokens).toBe(32_000);
    expect(snapshot.hideThinkingBlock).toBe(true);
  });

  it("lets project Pi settings override bundle MCP defaults", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      pluginSettings: {
        mcpServers: {
          bundleProbe: {
            command: "node",
            args: ["/plugins/probe.mjs"],
          },
        },
      } as EmbeddedPiSettingsArgs["pluginSettings"],
      projectSettings: {
        mcpServers: {
          bundleProbe: {
            command: "deno",
            args: ["/workspace/probe.ts"],
          },
        },
      } as EmbeddedPiSettingsArgs["projectSettings"],
      policy: "sanitize",
    });

    expect((snapshot as Record<string, unknown>).mcpServers).toEqual({
      bundleProbe: {
        command: "deno",
        args: ["/workspace/probe.ts"],
      },
    });
  });
});

describe("createPreparedEmbeddedPiSettingsManager", () => {
  it("keeps trusted file-backed settings runtime-scoped after preparation", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-settings-"));
    try {
      const cwd = path.join(baseDir, "workspace");
      const agentDir = path.join(baseDir, "agent");
      const projectSettingsDir = path.join(cwd, ".pi");
      const agentSettingsPath = path.join(agentDir, "settings.json");
      await fs.mkdir(projectSettingsDir, { recursive: true });
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        agentSettingsPath,
        JSON.stringify({ retry: { enabled: true } }, null, 2),
        "utf8",
      );
      await fs.writeFile(
        path.join(projectSettingsDir, "settings.json"),
        JSON.stringify({ shellCommandPrefix: "echo trusted &&" }, null, 2),
        "utf8",
      );

      const settingsManager = createPreparedEmbeddedPiSettingsManager({
        cwd,
        agentDir,
        cfg: {
          agents: { defaults: { embeddedPi: { projectSettingsPolicy: "trusted" } } },
        },
      });

      expect(settingsManager.getShellCommandPrefix()).toBe("echo trusted &&");
      expect(settingsManager.getRetryEnabled()).toBe(true);

      settingsManager.setRetryEnabled(false);
      await settingsManager.flush();

      const diskSettings = JSON.parse(await fs.readFile(agentSettingsPath, "utf8")) as {
        retry?: { enabled?: boolean };
      };
      expect(diskSettings.retry?.enabled).toBe(true);
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});

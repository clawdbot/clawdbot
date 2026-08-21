import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { BundledNodeHostPlugin } from "./mac-node-host-plugin-definitions.js";
import { createMacNodeHostPluginRegistry } from "./mac-node-host-plugin-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function availableCommands(
  registry: ReturnType<
    (typeof import("./mac-node-host-plugin-runtime.js"))["createMacNodeHostPluginRegistry"]
  >,
  config: Record<string, unknown>,
): string[] {
  const context = { config, env: process.env } as never;
  return registry.nodeHostCommands
    .filter((entry) => entry.command.isAvailable?.(context) !== false)
    .map((entry) => entry.command.command)
    .toSorted();
}

function plugin(id: string, command: string, enabledByDefault = true): BundledNodeHostPlugin {
  return {
    enabledByDefault,
    definition: {
      id,
      name: id,
      register(api) {
        api.registerNodeHostCommand({ command, handle: async () => "{}" });
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function useIsolatedState(): void {
  const root = tempDirs.make("openclaw-mac-node-host-plugins-");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
}

describe("macOS bundled node-host plugin runtime", () => {
  it("matches the default external worker command surface without CUA", () => {
    useIsolatedState();
    const registry = createMacNodeHostPluginRegistry({}, [
      plugin("google-meet", "googlemeet.chrome"),
      plugin("ollama", "ollama.chat"),
      plugin("ollama-extra", "ollama.models"),
      plugin("teams-meetings", "teamsmeetings.chrome"),
      plugin("zoom-meetings", "zoommeetings.chrome"),
    ]);

    expect(availableCommands(registry, {})).toEqual([
      "googlemeet.chrome",
      "ollama.chat",
      "ollama.models",
      "teamsmeetings.chrome",
      "zoommeetings.chrome",
    ]);
  });

  it("preserves plugin enablement policy inside the signed composition", () => {
    useIsolatedState();
    const registry = createMacNodeHostPluginRegistry(
      { plugins: { entries: { "google-meet": { enabled: false } } } },
      [
        plugin("google-meet", "googlemeet.chrome"),
        plugin("teams-meetings", "teamsmeetings.chrome"),
      ],
    );

    const commands = availableCommands(registry, {
      plugins: { entries: { "google-meet": { enabled: false } } },
    });
    expect(commands).not.toContain("googlemeet.chrome");
    expect(commands).toContain("teamsmeetings.chrome");
  });
});

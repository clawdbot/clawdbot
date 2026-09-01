import { describe, expect, it, vi } from "vitest";
import { splitArgs } from "./command-handler-args.js";
import { handleCodexPluginsSubcommand } from "./command-plugins-management.js";
import {
  buttonCommands,
  fakeCtx,
  inMemoryIO,
  pluginRuntime,
} from "./command-plugins-management.test-support.js";

describe("Codex plugin navigation", () => {
  it("offers bounded configured status choices without reading hosted inventory", async () => {
    const io = inMemoryIO(
      Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [
          `plugin-${index}`,
          { pluginName: `plugin-${index}`, marketplaceName: "company-tools", enabled: false },
        ]),
      ),
    );
    const runtime = pluginRuntime();
    const result = await handleCodexPluginsSubcommand(fakeCtx, ["status"], io, runtime);
    expect(buttonCommands(result).map(splitArgs)).toEqual([
      ...Array.from({ length: 5 }, (_, index) => [
        "/codex",
        "plugins",
        "status",
        `plugin-${index}`,
      ]),
      ["/codex", "plugins", "available"],
    ]);
    expect(result.text).toContain("/codex plugins list");
    expect(runtime.list).not.toHaveBeenCalled();
    expect(runtime.install).not.toHaveBeenCalled();
  });

  it("routes an empty status picker to Codex discovery and protects it from ordinary senders", async () => {
    const io = inMemoryIO();
    const read = vi.spyOn(io, "readConfig");
    const denied = await handleCodexPluginsSubcommand(
      { ...fakeCtx, senderIsOwner: false },
      ["status"],
      io,
    );
    expect(denied.text).toContain("Only an owner or operator.admin");
    expect(read).not.toHaveBeenCalled();
    const empty = await handleCodexPluginsSubcommand(fakeCtx, ["status"], io);
    expect(empty.text).toContain("No Codex plugins are explicitly configured");
    expect(buttonCommands(empty)).toEqual(["/codex plugins available"]);
  });

  it.each(["my notes", String.raw`reviewer's "notes"\archive`])(
    "opens status from the picker for configured alias %s",
    async (configKey) => {
      const io = inMemoryIO({
        [configKey]: {
          pluginName: "security-review",
          marketplaceName: "company-tools",
          enabled: true,
        },
      });
      const runtime = pluginRuntime({ installed: true, enabled: true });
      const picker = await handleCodexPluginsSubcommand(fakeCtx, ["status"], io, runtime);
      const [command, subcommand, ...args] = splitArgs(buttonCommands(picker)[0]);
      expect([command, subcommand]).toEqual(["/codex", "plugins"]);
      const result = await handleCodexPluginsSubcommand(fakeCtx, args, io, {
        ...runtime,
        withContext: (run) =>
          runtime.withContext((context) => run({ ...context, current: io.currentConfig() })),
      });
      expect(result.text).toContain("Plugin: security-review");
      expect(result.text).toContain("Bundle: installed");
    },
  );
});

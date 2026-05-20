import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  handleCodexPluginsSubcommand,
  type CodexPluginsConfigBlock,
  type CodexPluginConfigEntry,
  type CodexPluginsManagementIO,
} from "./command-plugins-management.js";

function inMemoryIO(
  initial: Record<string, CodexPluginConfigEntry> = {},
  options: { enabled?: boolean } = { enabled: true },
): CodexPluginsManagementIO & {
  current: () => Record<string, CodexPluginConfigEntry>;
  currentConfig: () => CodexPluginsConfigBlock;
} {
  const store: CodexPluginsConfigBlock = {
    enabled: options.enabled,
    plugins: JSON.parse(JSON.stringify(initial)),
  };
  return {
    current: () => JSON.parse(JSON.stringify(store.plugins ?? {})),
    currentConfig: () => JSON.parse(JSON.stringify(store)),
    readConfig: () => Promise.resolve(JSON.parse(JSON.stringify(store))),
    mutate: async (update) => {
      update(store);
    },
  };
}

const fakeCtx: PluginCommandContext = {
  args: "",
  config: {},
  channel: "test",
  isAuthorizedSender: true,
  senderIsOwner: true,
  commandBody: "/codex plugins",
  requestConversationBinding: async () => ({ status: "error", message: "unused" }),
  detachConversationBinding: async () => ({ removed: false }),
  getCurrentConversationBinding: async () => null,
};

describe("Codex /codex plugins subcommand", () => {
  it("lists a configured plugin with its enabled marker and explains the underlying file", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["list"], io);
    expect(result.text).toContain("ON   google-calendar");
    expect(result.text).toContain("openclaw.json");
  });

  it("lists effective disabled status when the global plugin switch is off", async () => {
    const io = inMemoryIO(
      {
        "google-calendar": {
          enabled: true,
          marketplaceName: "openai-curated",
          pluginName: "google-calendar",
        },
      },
      { enabled: false },
    );

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["list"], io);
    expect(result.text).toContain("OFF  google-calendar");
    expect(result.text).toContain("Global codexPlugins.enabled is off");
  });

  it("enables and disables a configured plugin and reflects the change in subsequent reads", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });

    const disabled = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["disable", "google-calendar"],
      io,
    );
    expect(disabled.text).toContain("disabled");
    expect(io.current()["google-calendar"]?.enabled).toBe(false);

    const enabled = await handleCodexPluginsSubcommand(fakeCtx, ["enable", "google-calendar"], io);
    expect(enabled.text).toContain("enabled");
    expect(io.currentConfig().enabled).toBe(true);
    expect(io.current()["google-calendar"]?.enabled).toBe(true);
  });

  it("rejects enable and disable from non-owner non-admin callers", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });
    const ctx = { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.write"] };

    const result = await handleCodexPluginsSubcommand(ctx, ["disable", "google-calendar"], io);
    expect(result.text).toContain("Only an owner or operator.admin");
    expect(io.current()["google-calendar"]?.enabled).toBe(true);
  });

  it("allows operator.admin gateway callers to enable and disable", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });
    const ctx = { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.admin"] };

    const result = await handleCodexPluginsSubcommand(ctx, ["disable", "google-calendar"], io);
    expect(result.text).toContain("disabled");
    expect(io.current()["google-calendar"]?.enabled).toBe(false);
  });

  it("escapes configured plugin fields before listing them in chat", async () => {
    const io = inMemoryIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar_@team_*name*",
      },
    });

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["list"], io);
    expect(result.text).toContain("google-calendar");
    expect(result.text).toContain("google-calendar＿＠team＿∗name∗");
    expect(result.text).not.toContain("@team");
    expect(result.text).not.toContain("*name*");
  });

  it("reports when a target plugin is not configured rather than silently no-oping", async () => {
    const io = inMemoryIO();
    const result = await handleCodexPluginsSubcommand(fakeCtx, ["disable", "chrome_@ops"], io);
    expect(result.text).toContain("not configured");
    expect(result.text).toContain("chrome＿＠ops");
    expect(result.text).not.toContain("@ops");
  });

  it("returns usage when list, enable, or disable receives the wrong arity", async () => {
    const io = inMemoryIO();
    const listResult = await handleCodexPluginsSubcommand(fakeCtx, ["list", "chrome"], io);
    expect(listResult.text).toContain("Usage: /codex plugins list");

    const result = await handleCodexPluginsSubcommand(fakeCtx, ["disable"], io);
    expect(result.text).toContain("Usage: /codex plugins disable <name>");
    expect(result.presentation).toBeUndefined();

    const enableResult = await handleCodexPluginsSubcommand(fakeCtx, ["enable"], io);
    expect(enableResult.text).toContain("Usage: /codex plugins enable <name>");
    expect(enableResult.presentation).toBeUndefined();

    const extraResult = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["enable", "google-calendar", "extra"],
      io,
    );
    expect(extraResult.text).toContain("Usage: /codex plugins enable <name>");
  });
});

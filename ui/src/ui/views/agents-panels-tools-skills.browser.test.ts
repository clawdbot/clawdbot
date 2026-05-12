import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderAgentTools } from "./agents-panels-tools-skills.ts";

function createBaseParams(overrides: Partial<Parameters<typeof renderAgentTools>[0]> = {}) {
  return {
    agentId: "main",
    configForm: {
      agents: {
        list: [{ id: "main", tools: { profile: "full" } }],
      },
    } as Record<string, unknown>,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    toolsEffectiveLoading: false,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: true,
    onProfileChange: () => undefined,
    onOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    ...overrides,
  };
}

describe("agents tools panel (browser)", () => {
  it("renders catalog provenance and effective runtime tools", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogResult: {
            agentId: "main",
            profiles: [
              { id: "minimal", label: "Minimal" },
              { id: "coding", label: "Coding" },
              { id: "messaging", label: "Messaging" },
              { id: "full", label: "Full" },
            ],
            groups: [
              {
                id: "media",
                label: "Media",
                source: "core",
                tools: [
                  {
                    id: "tts",
                    label: "tts",
                    description: "Text-to-speech conversion",
                    source: "core",
                    defaultProfiles: [],
                  },
                ],
              },
              {
                id: "plugin:voice-call",
                label: "voice-call",
                source: "plugin",
                pluginId: "voice-call",
                tools: [
                  {
                    id: "voice_call",
                    label: "voice_call",
                    description: "Voice call tool",
                    source: "plugin",
                    pluginId: "voice-call",
                    optional: true,
                    defaultProfiles: [],
                  },
                ],
              },
            ],
          },
          toolsEffectiveResult: {
            agentId: "main",
            profile: "messaging",
            groups: [
              {
                id: "channel",
                label: "Channel tools",
                source: "channel",
                tools: [
                  {
                    id: "message",
                    label: "Message Actions",
                    description: "Send and manage messages in this channel",
                    rawDescription: "Send and manage messages in this channel",
                    source: "channel",
                    channelId: "guildchat",
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(
      Array.from(container.querySelectorAll(".agent-tools-pane > .label")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Available Right Now", "Quick Presets"]);
    const runtimeChip = container.querySelector(".agent-tools-runtime-chip");
    expect(runtimeChip?.querySelector(".mono")?.textContent?.trim()).toBe("Message Actions");
    expect(runtimeChip?.querySelector(".agent-tools-runtime-chip__meta")?.textContent?.trim()).toBe(
      "Channel: guildchat",
    );
    expect(
      Array.from(container.querySelectorAll(".agent-tools-group__title > .agent-pill")).map(
        (pill) => pill.textContent?.trim(),
      ),
    ).toEqual(["Plugin: voice-call"]);
    expect(
      Array.from(container.querySelectorAll(".agent-tool-card")).map((card) => ({
        title: card.querySelector(".agent-tool-title")?.textContent?.trim(),
        badges: Array.from(card.querySelectorAll(".agent-tool-summary__badges .agent-pill")).map(
          (pill) => pill.textContent?.trim(),
        ),
      })),
    ).toEqual([
      { title: "tts", badges: ["Built-In"] },
      { title: "voice_call", badges: ["Plugin: voice-call", "Optional"] },
    ]);
    expect(container.querySelector(".agent-tool-card[open]")).toBeNull();
  });

  it("shows fallback warning when runtime catalog fails", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogError: "unavailable",
          toolsCatalogResult: null,
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".callout.info")?.textContent?.trim()).toBe(
      "Could not load runtime tool catalog. Showing built-in fallback list instead.",
    );
  });

  it("closes expanded tool rows when the parent group collapses", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogResult: {
            agentId: "main",
            profiles: [{ id: "full", label: "Full" }],
            groups: [
              {
                id: "files",
                label: "Files",
                source: "core",
                tools: [
                  {
                    id: "read",
                    label: "read",
                    description: "Read file contents",
                    source: "core",
                    defaultProfiles: ["full"],
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const group = container.querySelector<HTMLDetailsElement>(".agent-tools-group");
    const tool = container.querySelector<HTMLDetailsElement>(".agent-tool-card");

    expect(group).toBeInstanceOf(HTMLDetailsElement);
    expect(tool).toBeInstanceOf(HTMLDetailsElement);
    expect(group ? [...group.classList] : []).toEqual(["agent-tools-group"]);
    expect(tool ? [...tool.classList] : []).toEqual(["agent-tool-card"]);

    if (!group || !tool) {
      throw new Error("expected agent tool group and card");
    }

    group.open = true;
    tool.open = true;

    group.open = false;
    group.dispatchEvent(new Event("toggle"));

    expect(tool.open).toBe(false);
  });

  it("keeps the access toggle inside the collapsed tool summary", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogResult: {
            agentId: "main",
            profiles: [{ id: "full", label: "Full" }],
            groups: [
              {
                id: "files",
                label: "Files",
                source: "core",
                tools: [
                  {
                    id: "read",
                    label: "read",
                    description: "Read file contents",
                    source: "core",
                    defaultProfiles: ["full"],
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const tool = container.querySelector<HTMLDetailsElement>(".agent-tool-card");
    const summary = container.querySelector<HTMLElement>(".agent-tool-summary");
    const toggle = container.querySelector<HTMLInputElement>(".agent-tool-toggle input");

    expect(tool?.open).toBe(false);
    expect(toggle?.closest(".agent-tool-summary")).toBe(summary);
  });

  it("uses section-level plugin provenance for tool details", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogResult: {
            agentId: "main",
            profiles: [{ id: "full", label: "Full" }],
            groups: [
              {
                id: "plugin:voice-call",
                label: "voice-call",
                source: "plugin",
                pluginId: "voice-call",
                tools: [
                  {
                    id: "voice_call",
                    label: "voice_call",
                    description: "Voice call tool",
                    source: undefined as never,
                    defaultProfiles: ["full"],
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const tool = container.querySelector<HTMLDetailsElement>(".agent-tool-card");
    tool!.open = true;

    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".agent-tool-detail")).map((detail) => ({
        label: detail.querySelector(".label")?.textContent?.trim(),
        value: detail.lastElementChild?.textContent?.trim(),
      })),
    ).toEqual([
      { label: "Access", value: "Enabled by the current profile." },
      { label: "Source", value: "Plugin: voice-call" },
      { label: "Default Presets", value: "full" },
      { label: "Current Session", value: "Not available in this chat session right now." },
    ]);
  });

  it("opens the collapsed group and tool row from a live tool chip", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderAgentTools(
        createBaseParams({
          toolsCatalogResult: {
            agentId: "main",
            profiles: [{ id: "full", label: "Full" }],
            groups: [
              {
                id: "files",
                label: "Files",
                source: "core",
                tools: [
                  {
                    id: "read",
                    label: "read",
                    description: "Read file contents",
                    source: "core",
                    defaultProfiles: ["full"],
                  },
                ],
              },
            ],
          },
          toolsEffectiveResult: {
            agentId: "main",
            profile: "full",
            groups: [
              {
                id: "core",
                label: "Built-in tools",
                source: "core",
                tools: [
                  {
                    id: "read",
                    label: "read",
                    description: "Read file contents",
                    rawDescription: "Read file contents",
                    source: "core",
                  },
                ],
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const group = container.querySelector<HTMLDetailsElement>(".agent-tools-group");
    const tool = container.querySelector<HTMLDetailsElement>(".agent-tool-card");
    const chip = container.querySelector<HTMLAnchorElement>(
      '.agent-tools-runtime-chip[href="#agent-tool-read"]',
    );

    expect(group).toBeInstanceOf(HTMLDetailsElement);
    expect(tool).toBeInstanceOf(HTMLDetailsElement);
    expect(group ? [...group.classList] : []).toEqual(["agent-tools-group"]);
    expect(tool ? [...tool.classList] : []).toEqual(["agent-tool-card"]);
    expect(chip?.getAttribute("href")).toBe("#agent-tool-read");

    if (!group || !tool || !chip) {
      container.remove();
      throw new Error("expected agent tool runtime chip");
    }

    expect(group.open).toBe(false);
    expect(tool.open).toBe(false);

    chip.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(group.open).toBe(true);
    expect(tool.open).toBe(true);

    container.remove();
  });
});

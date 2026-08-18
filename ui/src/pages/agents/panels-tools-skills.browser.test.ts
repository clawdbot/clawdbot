// Control UI tests cover agents panels tools skills behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry } from "../../api/types.ts";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
import { GitHubIdentityController } from "./github-identity-controller.ts";
import { renderAgentSkills, renderAgentTools } from "./panels-tools-skills.ts";

installBrowserHistoryIsolation();

function createBaseParams(overrides: Partial<Parameters<typeof renderAgentTools>[0]> = {}) {
  const githubIdentity = new GitHubIdentityController({
    requestUpdate: () => undefined,
    runExternalMutation: async () => ({
      ok: false,
      reason: "unavailable",
      error: "Mutation unavailable in rendering test.",
    }),
  });
  githubIdentity.sync({
    client: null,
    connected: false,
    agentId: "main",
    config: null,
    supported: true,
    configurable: false,
    clientRevision: 0,
  });
  return {
    agentId: "main",
    canUpdateConfig: true,
    configForm: {
      agents: {
        entries: { main: { default: true, tools: { profile: "full" } } },
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
    githubIdentity,
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
              {
                id: "mcp",
                label: "MCP server tools",
                source: "mcp",
                tools: [
                  {
                    id: "reproProbe__probe_tool",
                    label: "Probe Tool",
                    description: "Probe from MCP",
                    rawDescription: "Probe from MCP",
                    source: "mcp",
                    pluginId: "bundle-mcp",
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
      Array.from(container.querySelectorAll(".settings-section__heading")).map((heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(["Tool Access", "Available Right Now", "GitHub Identity", "Tool Catalog"]);
    expect(
      Array.from(container.querySelectorAll(".settings-row__title")).some(
        (title) => title.textContent?.trim() === "Quick Presets",
      ),
    ).toBe(true);
    const runtimeChips = Array.from(container.querySelectorAll(".agent-tools-runtime-chip")).map(
      (chip) => ({
        label: chip.querySelector(".mono")?.textContent?.trim(),
        meta: chip.querySelector(".agent-tools-runtime-chip__meta")?.textContent?.trim(),
      }),
    );
    expect(runtimeChips).toEqual([
      { label: "Message Actions", meta: "Channel: guildchat" },
      { label: "Probe Tool", meta: "MCP" },
    ]);
    expect(
      Array.from(
        container.querySelectorAll(".agent-tools-group__title > .settings-row__value"),
      ).map((pill) => pill.textContent?.trim()),
    ).toEqual(["Plugin: voice-call"]);
    expect(
      Array.from(container.querySelectorAll(".agent-tool-card")).map((card) => ({
        title: card.querySelector(".agent-tool-title")?.textContent?.trim(),
        badges: Array.from(
          card.querySelectorAll(".agent-tool-summary__badges .settings-row__value"),
        ).map((pill) => pill.textContent?.trim()),
      })),
    ).toEqual([
      { title: "tts", badges: ["Built-In"] },
      { title: "voice_call", badges: ["Plugin: voice-call", "Optional"] },
    ]);
    expect(container.querySelector(".agent-tool-card[open]")).toBeNull();
  });

  it("renders the GitHub identity section with settings rows only", async () => {
    const container = document.createElement("div");
    const params = createBaseParams();
    params.githubIdentity.status = {
      agentId: "main",
      source: "system-detected",
      credentialState: "available",
      account: { login: "octocat", avatarUrl: "https://example.test/a.png" },
      gitAuthor: { name: null, email: null },
      evidence: "github-api",
    };
    render(renderAgentTools(params), container);
    await Promise.resolve();

    const section = Array.from(container.querySelectorAll(".settings-section")).find((candidate) =>
      candidate.querySelector(".settings-section__heading")?.textContent?.includes("GitHub"),
    );
    expect(section).toBeDefined();
    if (!section) {
      throw new Error("expected GitHub identity section");
    }
    // The whole section stays inside the one group surface: no bespoke form
    // markup or nested callouts, per ui/docs/design-system/settings-design.md.
    expect(section.querySelector(".form-grid")).toBeNull();
    expect(section.querySelector(".callout")).toBeNull();
    expect(section.querySelector(".settings-group .settings-account__avatar")).not.toBeNull();
    expect(section.textContent).toContain("@octocat");
    expect(section.querySelector(".settings-status")?.textContent?.trim()).toBe("Verified");
    // Raw wire enums never render; friendly labels replace them.
    expect(section.textContent).not.toContain("system-detected");
    expect(section.textContent).not.toContain("github-api");
    const authorRow = Array.from(section.querySelectorAll(".settings-row")).find((row) =>
      row.querySelector(".settings-row__title")?.textContent?.includes("Git Author"),
    );
    expect(authorRow?.querySelector(".settings-row__value")?.textContent?.trim()).toBe("Not set");
    expect(section.querySelector(".settings-segmented")).not.toBeNull();
    expect(section.querySelector(".settings-secret input")).not.toBeNull();
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

  it("renders effective tool notices", async () => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          toolsEffectiveResult: {
            agentId: "main",
            profile: "full",
            groups: [],
            notices: [
              {
                id: "mcp-not-yet-connected",
                severity: "info",
                message: "MCP servers are configured but not connected yet.",
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".agent-tools-notices .callout.info")?.textContent?.trim()).toBe(
      "MCP servers are configured but not connected yet.",
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
    const toggle = container.querySelector(".agent-tool-toggle wa-switch");

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

    const previousUrl = window.location.href;
    // Shared jsdom workers can observe URL changes before finally/afterEach,
    // so inspect the intended deep link without mutating browser history.
    const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    try {
      chip.click();
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });

      expect(group.open).toBe(true);
      expect(tool.open).toBe(true);
      expect(replaceState).toHaveBeenCalledOnce();
      const requestedUrl = replaceState.mock.calls[0]?.[2];
      expect(requestedUrl).toBeInstanceOf(URL);
      expect((requestedUrl as URL).hash).toBe("#agent-tool-read");
      expect(window.location.href).toBe(previousUrl);
    } finally {
      replaceState.mockRestore();
      container.remove();
    }
  });
});

describe("agents skills panel (browser)", () => {
  it("gates allowlist clearing separately from staged config edits", async () => {
    const container = document.createElement("div");
    render(
      renderAgentSkills({
        agentId: "main",
        canPatchConfig: false,
        canUpdateConfig: true,
        report: {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [],
        },
        loading: false,
        error: null,
        activeAgentId: "main",
        configForm: { agents: { entries: { main: { skills: ["coding-agent"] } } } },
        configLoading: false,
        configSaving: false,
        configDirty: false,
        filter: "",
        onFilterChange: () => undefined,
        onRefresh: () => undefined,
        onToggle: () => undefined,
        onClear: () => undefined,
        onDisableAll: () => undefined,
        onConfigReload: () => undefined,
        onConfigSave: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[1]?.disabled).toBe(false);
    expect(buttons[2]?.disabled).toBe(true);
  });

  it("explains an unsatisfied one-of binary requirement", async () => {
    const container = document.createElement("div");
    const skill: SkillStatusEntry = {
      name: "Coding Agent",
      description: "Delegate coding work to an available coding CLI.",
      source: "openclaw-bundled",
      bundled: true,
      filePath: "/tmp/skills/coding-agent/SKILL.md",
      baseDir: "/tmp/skills/coding-agent",
      skillKey: "coding-agent",
      always: false,
      disabled: false,
      blockedByAllowlist: false,
      blockedByAgentFilter: false,
      eligible: false,
      requirements: {
        bins: [],
        anyBins: ["claude", "codex", "opencode"],
        env: [],
        config: [],
        os: [],
      },
      missing: {
        bins: [],
        anyBins: ["claude", "codex", "opencode"],
        env: [],
        config: [],
        os: [],
      },
      configChecks: [],
      install: [{ id: "node-codex", kind: "node", label: "Install Codex CLI", bins: ["codex"] }],
    };

    render(
      renderAgentSkills({
        agentId: "main",
        canPatchConfig: true,
        canUpdateConfig: true,
        report: {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [skill],
        },
        loading: false,
        error: null,
        activeAgentId: "main",
        configForm: { agents: { entries: { main: { default: true } } } },
        configLoading: false,
        configSaving: false,
        configDirty: false,
        filter: "",
        onFilterChange: () => undefined,
        onRefresh: () => undefined,
        onToggle: () => undefined,
        onClear: () => undefined,
        onDisableAll: () => undefined,
        onConfigReload: () => undefined,
        onConfigSave: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".agent-skill-row")?.textContent).toContain(
      "bin:any of (claude, codex, opencode)",
    );
  });
});

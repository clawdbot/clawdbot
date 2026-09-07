// Control UI tests cover agents panels tools skills behavior.
import { render } from "lit";
import { assert, describe, expect, it, vi } from "vitest";
import type { SkillStatusEntry } from "../../api/types.ts";
import { GitHubIdentityController } from "../../features/github-connections/github-identity-controller.ts";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
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
    target: { kind: "shared", scope: "agent", agentId: "main", config: null },
    statusReadable: true,
    configurable: false,
    authorizable: false,
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
    onOpenGitHubConnections: vi.fn(),
    onProfileChange: () => undefined,
    onOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    ...overrides,
  };
}

function createSkill(
  name: string,
  options: { source?: string; bundled?: boolean; blockedByAgentFilter?: boolean } = {},
): SkillStatusEntry {
  return {
    name,
    description: `${name} skill`,
    source: options.source ?? "openclaw-managed",
    bundled: options.bundled ?? false,
    filePath: `/tmp/skills/${name}/SKILL.md`,
    baseDir: `/tmp/skills/${name}`,
    skillKey: name,
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: options.blockedByAgentFilter ?? false,
    eligible: true,
    requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
    missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
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
    ).toEqual(["Tool Access", "Available Right Now", "GitHub account", "Tool Catalog"]);
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
    const nativeIdentity = {
      source: "system-detected" as const,
      credentialKind: "native" as const,
      credentialState: "available" as const,
      account: { login: "octocat" },
      gitAuthor: { name: null, email: null },
      evidence: "github-api" as const,
      accessExpiresAtMs: null,
      refreshState: "not_applicable" as const,
      oauthScopes: [],
      repositoryGrants: "unknown" as const,
    };
    params.githubIdentity.status = {
      agentId: "main",
      selectedScope: "system",
      selected: { scope: "system", configured: false, identity: nativeIdentity },
      effective: nativeIdentity,
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
    expect(section.querySelector(".settings-group .settings-account__avatar")).toBeNull();
    expect(section.textContent).toContain("@octocat");
    expect(section.querySelector(".settings-status")?.textContent?.trim()).toBe("Verified");
    // Raw wire enums never render; friendly labels replace them.
    expect(section.textContent).not.toContain("system-detected");
    expect(section.textContent).not.toContain("github-api");
    const authorRow = Array.from(section.querySelectorAll(".settings-row")).find((row) =>
      row.querySelector(".settings-row__title")?.textContent?.includes("Git Author"),
    );
    expect(authorRow?.querySelector(".settings-row__value")?.textContent?.trim()).toBe("Not set");
    expect(section.querySelector(".settings-segmented")).toBeNull();
    expect(section.querySelector(".settings-secret input")).toBeNull();
    expect(section.textContent).toContain("Manage connections in Profile");
    expect(section.textContent).not.toContain("Advanced: agent GitHub override");
  });

  it("renders only the pinned device link and one-time code while authorization is active", async () => {
    const container = document.createElement("div");
    const client = {
      request: vi.fn(async () => ({
        requestId: "github-device-11111111111111111111111111111111",
        userCode: "ABCD-1234",
        verificationUri: "https://github.com/login/device",
        expiresInMs: 900_000,
        pollAfterMs: 60_000,
      })),
    } as never;
    const githubIdentity = new GitHubIdentityController({
      requestUpdate: () => undefined,
      runExternalMutation: async () => ({
        ok: false,
        reason: "unavailable",
        error: "not used",
      }),
    });
    githubIdentity.sync({
      client,
      connected: true,
      target: { kind: "shared", scope: "agent", agentId: "main", config: {} },
      statusReadable: true,
      configurable: true,
      authorizable: true,
      clientRevision: 1,
    });
    await githubIdentity.startAuthorization();

    render(renderAgentTools(createBaseParams({ githubIdentity })), container);
    await Promise.resolve();

    expect(container.textContent).toContain("ABCD-1234");
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/login/device"]',
    );
    expect(link?.textContent?.trim()).toBe("Open github.com/login/device");
    expect(link?.target).toBe("_blank");
    expect(link?.rel.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    expect(container.querySelector(".settings-secret input")).toBeNull();
    expect(container.textContent).not.toContain("github-device-11111111111111111111111111111111");
    expect(container.querySelector(".settings-segmented")).toBeNull();
    githubIdentity.dispose();
  });

  it("keeps complete effective facts when This Agent inherits System", async () => {
    const container = document.createElement("div");
    const params = createBaseParams();
    const effective = {
      source: "system-configured" as const,
      credentialKind: "managed-oauth" as const,
      credentialState: "available" as const,
      account: { login: "system-user" },
      gitAuthor: { name: "System Author", email: "system@example.com" },
      evidence: "github-api" as const,
      accessExpiresAtMs: 1_900_000_000_000,
      refreshState: "available" as const,
      oauthScopes: ["repo", "workflow"],
      repositoryGrants: "unknown" as const,
    };
    params.githubIdentity.status = {
      agentId: "main",
      selectedScope: "agent",
      selected: { scope: "agent", configured: false, identity: null },
      effective,
    };

    render(renderAgentTools(params), container);
    await Promise.resolve();

    expect(container.textContent).toContain("@system-user");
    expect(container.textContent).toContain("System Author · system@example.com");
    expect(container.textContent).toContain("Managed GitHub authorization");
    expect(container.textContent).toContain("repo, workflow");
    expect(container.textContent).toContain("System GitHub");
  });

  it("keeps PAT fields hidden until the explicit fallback is selected", async () => {
    const container = document.createElement("div");
    const client = { request: vi.fn() } as never;
    const githubIdentity = new GitHubIdentityController({
      requestUpdate: () => undefined,
      runExternalMutation: async () => ({
        ok: false,
        reason: "unavailable",
        error: "not used",
      }),
    });
    githubIdentity.sync({
      client,
      connected: true,
      target: { kind: "shared", scope: "agent", agentId: "main", config: {} },
      statusReadable: true,
      configurable: true,
      authorizable: true,
      clientRevision: 1,
    });

    render(renderAgentTools(createBaseParams({ githubIdentity })), container);
    await Promise.resolve();
    expect(container.querySelector(".settings-secret input")).toBeNull();
    expect(container.textContent).toContain("Use a PAT instead");

    githubIdentity.showPatFallback();
    render(renderAgentTools(createBaseParams({ githubIdentity })), container);
    await Promise.resolve();
    expect(container.querySelector(".settings-secret input")).not.toBeNull();
    expect(container.textContent).not.toContain("Continue with GitHub");

    githubIdentity.busy = true;
    render(renderAgentTools(createBaseParams({ githubIdentity })), container);
    await Promise.resolve();
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Cancel",
    );
    expect(cancel?.disabled).toBe(true);
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

  it.each([
    { reduced: true, behavior: "auto" },
    { reduced: false, behavior: "smooth" },
  ] as const)("opens a live tool chip with $behavior scrolling", async ({ reduced, behavior }) => {
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

    const summary = tool.querySelector<HTMLElement>("summary");
    if (!summary) {
      container.remove();
      throw new Error("expected agent tool summary");
    }
    const scrollIntoView = vi.fn();
    tool.scrollIntoView = scrollIntoView;
    const focus = vi.spyOn(summary, "focus");
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: reduced }));
    const previousUrl = window.location.href;
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
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior });
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      focus.mockRestore();
      replaceState.mockRestore();
      container.remove();
    }
  });

  it.each([
    {
      name: "enables one profile tool",
      tool: "session_status",
      enabled: true,
      expectedAllow: ["untouched", "exec", "web_*"],
      expectedDeny: ["read", "web_*"],
    },
    {
      name: "disables one aliased tool",
      tool: "bash",
      enabled: false,
      expectedAllow: ["untouched", "web_*"],
      expectedDeny: ["session_status", "read", "web_*", "exec"],
    },
    {
      name: "enables the catalog without removing wildcard denies",
      tool: null,
      enabled: true,
      expectedAllow: ["untouched", "exec", "web_*", "web_fetch"],
      expectedDeny: ["read", "web_*"],
    },
    {
      name: "disables the catalog without removing wildcard allows",
      tool: null,
      enabled: false,
      expectedAllow: ["untouched", "web_*"],
      expectedDeny: ["session_status", "read", "web_*", "exec", "web_fetch"],
    },
    {
      name: "publishes one normalized update for an empty catalog",
      tool: null,
      enabled: true,
      emptyCatalog: true,
      expectedAllow: ["untouched", "exec", "web_*"],
      expectedDeny: ["session_status", "read", "web_*"],
    },
  ])("$name with one immutable override update", async (testCase) => {
    const tools = {
      profile: "minimal",
      alsoAllow: [" untouched ", " BASH ", "exec", "", "web_*"],
      deny: [" SESSION_STATUS ", "read", "web_*", "", "read"],
    };
    const configForm = { agents: { entries: { main: { tools } } } };
    const originalConfig = structuredClone(configForm);
    const onOverridesChange = vi.fn();
    const toolIds = testCase.emptyCatalog ? [] : ["session_status", "bash", "web_fetch"];
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          configForm,
          onOverridesChange,
          toolsCatalogResult: {
            agentId: "main",
            profiles: [{ id: "minimal", label: "Minimal" }],
            groups: [
              {
                id: "policy",
                label: "Policy",
                source: "core",
                tools: toolIds.map((id) => ({
                  id,
                  label: id,
                  description: id,
                  source: "core" as const,
                  defaultProfiles: [],
                })),
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    if (testCase.tool) {
      const card = Array.from(container.querySelectorAll(".agent-tool-card")).find(
        (entry) => entry.querySelector(".agent-tool-title")?.textContent?.trim() === testCase.tool,
      );
      const toggle = card?.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
      assert(toggle, `Missing tool switch: ${testCase.tool}`);
      expect(toggle.checked).toBe(!testCase.enabled);
      toggle.checked = testCase.enabled;
      toggle.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const label = testCase.enabled ? "Enable All" : "Disable All";
      const button = Array.from(container.querySelectorAll("button")).find(
        (entry) => entry.textContent?.trim() === label,
      );
      assert(button, `Missing bulk control: ${label}`);
      button.click();
    }

    expect(onOverridesChange).toHaveBeenCalledExactlyOnceWith(
      "main",
      testCase.expectedAllow,
      testCase.expectedDeny,
    );
    expect(configForm).toEqual(originalConfig);
  });

  it.each([
    {
      name: "prefix wildcard",
      tools: { allow: ["web_*"] },
      expected: { web_fetch: true, web_: true, read: false },
    },
    {
      name: "suffix wildcard",
      tools: { allow: ["*fetch"] },
      expected: { web_fetch: true, read: false },
    },
    {
      name: "literal dots in wildcard",
      tools: { allow: ["mcp.server.*"] },
      expected: { "mcp.server.tool": true, mcpXserverXtool: false },
    },
    {
      name: "base exec alias and direct deny",
      tools: { allow: [" BASH "], deny: ["exec"] },
      expected: { exec: false, apply_patch: true, write: false },
    },
    {
      name: "override exec deny",
      tools: { profile: "full", deny: ["exec"] },
      expected: { exec: false, apply_patch: false, write: true },
    },
    {
      name: "group expansion and direct deny",
      tools: { allow: ["group:fs"], deny: ["write"] },
      expected: { read: true, write: false, apply_patch: true },
    },
  ])("renders policy-controlled switches: $name", async ({ tools, expected }) => {
    const container = document.createElement("div");
    render(
      renderAgentTools(
        createBaseParams({
          configForm: {
            agents: { entries: { main: { default: true, tools } } },
          },
          toolsCatalogResult: {
            agentId: "main",
            profiles: [{ id: "full", label: "Full" }],
            groups: [
              {
                id: "policy",
                label: "Policy",
                source: "core",
                tools: Object.keys(expected).map((id) => ({
                  id,
                  label: id,
                  description: id,
                  source: "core" as const,
                  defaultProfiles: [],
                })),
              },
            ],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(
      Object.fromEntries(
        Array.from(container.querySelectorAll(".agent-tool-card"), (card) => [
          card.querySelector(".agent-tool-title")?.textContent?.trim(),
          card.querySelector<HTMLElement & { checked: boolean }>("wa-switch")?.checked,
        ]),
      ),
    ).toEqual(expected);
  });
});

describe("agents skills panel (browser)", () => {
  it("shows matches from default-collapsed groups while filtering", async () => {
    const container = document.createElement("div");
    const params: Parameters<typeof renderAgentSkills>[0] = {
      agentId: "main",
      canPatchConfig: true,
      canUpdateConfig: true,
      report: {
        workspaceDir: "/tmp/workspace",
        managedSkillsDir: "/tmp/skills",
        agentId: "main",
        skills: [
          createSkill("Unique Built In Match", {
            source: "openclaw-bundled",
            bundled: true,
          }),
          createSkill("Installed Distractor"),
        ],
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
    };

    render(renderAgentSkills(params), container);
    await Promise.resolve();
    const builtInGroup = container.querySelector<HTMLDetailsElement>(".agent-skills-group");
    expect(builtInGroup?.open).toBe(false);

    render(renderAgentSkills({ ...params, filter: "Unique Built In Match" }), container);
    await Promise.resolve();
    const filteredGroup = container.querySelector<HTMLDetailsElement>(".agent-skills-group");
    expect(container.textContent).toContain("1 shown");
    expect(filteredGroup?.open).toBe(true);
    expect(filteredGroup?.querySelector(".agent-skill-row")?.textContent).toContain(
      "Unique Built In Match",
    );
  });

  it("reflects an inherited default skill allowlist", async () => {
    const container = document.createElement("div");

    render(
      renderAgentSkills({
        agentId: "main",
        canPatchConfig: true,
        canUpdateConfig: true,
        report: {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          agentId: "main",
          agentSkillFilter: ["github"],
          skills: [createSkill("github"), createSkill("weather", { blockedByAgentFilter: true })],
        },
        loading: false,
        error: null,
        activeAgentId: "main",
        configForm: {
          agents: {
            defaults: { skills: ["github"] },
            entries: { main: { default: true } },
          },
        },
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

    expect(container.querySelector(".callout.info")?.textContent).toContain(
      "inherits the default skill allowlist",
    );
    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".agent-skill-row wa-switch")).map(
        (toggle) => (toggle as HTMLElement & { checked: boolean }).checked,
      ),
    ).toEqual([true, false]);
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(true);
  });

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
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(true);
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

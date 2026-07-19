// Control UI tests cover agents behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { renderAgentFiles } from "./panels-status-files.ts";
import { renderAgents } from "./view.ts";

type AgentsProps = Parameters<typeof renderAgents>[0];

function createSkill() {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
  };
}

function directText(element: Element | null | undefined): string | undefined {
  return Array.from(element?.childNodes ?? [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

function expectAgentTab(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-tab")).find(
    (candidate) => directText(candidate) === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected agent tab "${text}"`);
  }
  return button;
}

function createProps(overrides: Partial<AgentsProps> = {}): AgentsProps {
  return {
    basePath: "",
    authToken: null,
    loading: false,
    error: null,
    agentsList: {
      defaultId: "alpha",
      mainKey: "main",
      scope: "workspace",
      agents: [{ id: "alpha", name: "Alpha" } as never, { id: "beta", name: "Beta" } as never],
    },
    selectedAgentId: "beta",
    activePanel: "overview",
    config: {
      form: null,
      loading: false,
      saving: false,
      dirty: false,
    },
    channels: {
      snapshot: null,
      loading: false,
      error: null,
      lastSuccess: null,
    },
    cron: {
      status: null,
      jobs: [],
      loading: false,
      error: null,
    },
    agentFiles: {
      list: null,
      loading: false,
      error: null,
      active: null,
      contents: {},
      drafts: {},
      saving: false,
    },
    agentIdentityLoading: false,
    agentIdentityError: null,
    agentIdentityById: {},
    identityDraft: { name: null, emoji: null, avatar: null },
    identitySaving: false,
    identityError: null,
    agentSkills: {
      report: null,
      loading: false,
      error: null,
      agentId: null,
      filter: "",
    },
    toolsCatalog: {
      loading: false,
      error: null,
      result: null,
    },
    toolsEffective: {
      loading: false,
      error: null,
      result: null,
    },
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: false,
    modelCatalog: [],
    pinnedAgentIds: [],
    onRefresh: () => undefined,
    onSelectAgent: () => undefined,
    onCreateAgent: () => undefined,
    onSelectPanel: () => undefined,
    onLoadFiles: () => undefined,
    onSelectFile: () => undefined,
    onFileDraftChange: () => undefined,
    onFileReset: () => undefined,
    onFileSave: () => undefined,
    onToolsProfileChange: () => undefined,
    onToolsOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    onModelChange: () => undefined,
    onModelFallbacksChange: () => undefined,
    onChannelsRefresh: () => undefined,
    onCronRefresh: () => undefined,
    onCronRunNow: () => undefined,
    onSkillsFilterChange: () => undefined,
    onSkillsRefresh: () => undefined,
    onAgentSkillToggle: () => undefined,
    onAgentSkillsClear: () => undefined,
    onAgentSkillsDisableAll: () => undefined,
    onSetDefault: () => undefined,
    onIdentityFieldChange: () => undefined,
    onIdentityAvatarSelect: () => undefined,
    onIdentitySave: () => undefined,
    onTogglePinnedAgent: () => undefined,
    ...overrides,
  };
}

describe("renderAgents", () => {
  it("prefills the identity editor from the fetched agent identity", () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          agentIdentityById: {
            beta: { agentId: "beta", name: "Fetched Beta", avatar: "" },
          },
        }),
      ),
      container,
    );

    expect(
      container.querySelector<HTMLInputElement>(".agent-identity-editor__fields input")?.value,
    ).toBe("Fetched Beta");
  });

  it("renders Memory after Automations and scopes the panel to the selected agent", () => {
    const container = document.createElement("div");
    render(renderAgents(createProps({ activePanel: "memory" })), container);

    const tabs = [...container.querySelectorAll(".agent-tab")].map((tab) => directText(tab));
    expect(tabs.slice(-2)).toEqual([t("agents.tabs.cronJobs"), t("agents.tabs.memory")]);
    const panel = container.querySelector<HTMLElement & { agentId: string }>(
      "openclaw-agent-memory-panel",
    );
    expect(panel?.agentId).toBe("beta");
  });

  it("renders the custom agent select with the provided agents and selected label", async () => {
    const container = document.createElement("div");
    document.body.append(container);

    try {
      render(renderAgents(createProps()), container);
      const select = container.querySelector("openclaw-agent-select") as
        | (HTMLElement & {
            agents: Array<{ id: string }>;
            updateComplete: Promise<boolean>;
          })
        | null;
      expect(select).not.toBeNull();
      await select?.updateComplete;

      expect(select?.agents).toHaveLength(2);
      expect(select?.querySelector(".agent-select__label")?.textContent?.trim()).toBe("Beta");
    } finally {
      container.remove();
    }
  });

  it("selects the configured primary model on initial render", async () => {
    const container = document.createElement("div");
    const configForm = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
        list: [{ id: "alpha" }, { id: "beta" }],
      },
    };

    render(
      renderAgents(
        createProps({
          selectedAgentId: "alpha",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const defaultSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>("select.settings-select");
      expect(select?.value).toBe("openai/gpt-5.4");
      return select;
    });
    expect(defaultSelect?.selectedOptions[0]?.value).toBe("openai/gpt-5.4");

    render(
      renderAgents(
        createProps({
          selectedAgentId: "beta",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const inheritedSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>("select.settings-select");
      expect(select?.value).toBe("");
      return select;
    });
    expect(inheritedSelect?.selectedOptions[0]?.textContent?.trim()).toBe(
      "Inherit default (openai/gpt-5.4)",
    );
  });

  it("remounts overview model controls when switching selected agents", async () => {
    const container = document.createElement("div");
    const configForm = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
        list: [
          { id: "alpha", model: { primary: "anthropic/claude-sonnet-4-6" } },
          { id: "beta", model: { primary: "openai/gpt-5.4" } },
        ],
      },
    };

    render(
      renderAgents(
        createProps({
          selectedAgentId: "beta",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const betaSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>("select.settings-select");
      expect(
        Array.from(select?.options ?? []).some((option) => option.value === "openai/gpt-5.4"),
      ).toBe(true);
      return select;
    });

    render(
      renderAgents(
        createProps({
          selectedAgentId: "alpha",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const alphaSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>("select.settings-select");
      expect(
        Array.from(select?.options ?? []).some(
          (option) => option.value === "anthropic/claude-sonnet-4-6",
        ),
      ).toBe(true);
      return select;
    });
    expect(alphaSelect).not.toBe(betaSelect);
  });

  it("renders the resolved per-agent thinking default in the overview", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          agentsList: {
            defaultId: "alpha",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "alpha", name: "Alpha", thinkingDefault: "off" } as never,
              { id: "beta", name: "Beta", thinkingDefault: "xhigh" } as never,
            ],
          },
          selectedAgentId: "beta",
        }),
      ),
      container,
    );

    await Promise.resolve();

    const thinkingKv = Array.from(container.querySelectorAll(".settings-kv dt")).find(
      (entry) => entry.textContent?.trim() === t("agents.context.thinkingDefault"),
    );
    expect(thinkingKv?.nextElementSibling?.textContent).toContain("xhigh");
  });

  it("shows the skills count only for the selected agent's report", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "alpha",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    let skillsTab = expectAgentTab(container, "Skills");

    expect(skillsTab.textContent?.trim()).toBe("Skills");

    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    skillsTab = expectAgentTab(container, "Skills");

    expect(directText(skillsTab)).toBe("Skills");
    expect(skillsTab.querySelector(".agent-tab-count")?.textContent).toBe("1");
  });

  it("localizes agent tabs and the channel refresh never state", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("zh-CN");
    const container = document.createElement("div");

    try {
      render(
        renderAgents(
          createProps({
            activePanel: "channels",
            channels: {
              snapshot: null,
              loading: false,
              error: null,
              lastSuccess: null,
            },
          }),
        ),
        container,
      );
      await Promise.resolve();

      const tabLabels = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-tab")).map(
        (button) => button.textContent?.trim(),
      );

      expect(tabLabels).toEqual([
        "概览",
        "文件",
        "工具",
        "技能",
        "频道",
        t("agents.tabs.cronJobs"),
        "记忆",
      ]);
      const sectionDescs = Array.from(container.querySelectorAll(".settings-section__desc"));
      expect(sectionDescs.some((desc) => desc.textContent?.includes("上次刷新：从未"))).toBe(true);
    } finally {
      await i18n.setLocale("en");
      vi.unstubAllGlobals();
    }
  });
});

describe("renderAgentFiles", () => {
  it("does not accept another file selection while a file request is loading", () => {
    const container = document.createElement("div");
    const onSelectFile = vi.fn();

    render(
      renderAgentFiles({
        agentId: "alpha",
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "AGENTS.md",
              path: "/tmp/workspace/AGENTS.md",
              missing: false,
            },
            {
              name: "HEARTBEAT.md",
              path: "/tmp/workspace/HEARTBEAT.md",
              missing: false,
            },
          ],
        },
        agentFilesLoading: true,
        agentFilesError: null,
        agentFileActive: "AGENTS.md",
        agentFileContents: { "AGENTS.md": "# Instructions" },
        agentFileDrafts: { "AGENTS.md": "# Instructions" },
        agentFileSaving: false,
        onLoadFiles: () => undefined,
        onSelectFile,
        onFileDraftChange: () => undefined,
        onFileReset: () => undefined,
        onFileSave: () => undefined,
      }),
      container,
    );

    const heartbeatTab = expectAgentTab(container, "HEARTBEAT");
    expect(heartbeatTab.disabled).toBe(true);
    heartbeatTab.click();
    expect(onSelectFile).not.toHaveBeenCalled();
  });

  it("renders the upgraded markdown preview structure with file metadata", () => {
    const container = document.createElement("div");

    render(
      renderAgentFiles({
        agentId: "alpha",
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "USER.md",
              path: "/tmp/workspace/USER.md",
              missing: false,
              size: 128,
              updatedAtMs: 1_700_000_000_000,
            },
          ],
        },
        agentFilesLoading: false,
        agentFilesError: null,
        agentFileActive: "USER.md",
        agentFileContents: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileDrafts: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileSaving: false,
        onLoadFiles: () => undefined,
        onSelectFile: () => undefined,
        onFileDraftChange: () => undefined,
        onFileReset: () => undefined,
        onFileSave: () => undefined,
      }),
      container,
    );

    expect(container.querySelectorAll(".md-preview-dialog__reader.sidebar-markdown")).toHaveLength(
      1,
    );
    expect(container.querySelector(".md-preview-dialog__path")?.textContent?.trim()).toBe(
      "USER.md",
    );
    expect(container.querySelector(".md-preview-dialog__chip strong")?.textContent).toBe(
      "Saved Preview",
    );
    expect(container.querySelector(".md-preview-dialog__eyebrow span")?.textContent?.trim()).toBe(
      "Markdown Preview",
    );
  });

  it("renders preview header controls as icon-only buttons with accessible labels", () => {
    const container = document.createElement("div");

    render(
      renderAgentFiles({
        agentId: "alpha",
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "USER.md",
              path: "/tmp/workspace/USER.md",
              missing: false,
              size: 128,
              updatedAtMs: 1_700_000_000_000,
            },
          ],
        },
        agentFilesLoading: false,
        agentFilesError: null,
        agentFileActive: "USER.md",
        agentFileContents: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileDrafts: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileSaving: false,
        onLoadFiles: () => undefined,
        onSelectFile: () => undefined,
        onFileDraftChange: () => undefined,
        onFileReset: () => undefined,
        onFileSave: () => undefined,
      }),
      container,
    );

    const actions = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".md-preview-dialog__actions button"),
    );

    expect(actions).toHaveLength(3);
    expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Expand preview",
      "Edit file",
      "Close preview",
    ]);
    expect(actions.map((button) => button.textContent?.trim())).toEqual(["", "", ""]);
  });

  it("resets the expanded preview button state when the dialog closes", () => {
    const container = document.createElement("div");

    render(
      renderAgentFiles({
        agentId: "alpha",
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "USER.md",
              path: "/tmp/workspace/USER.md",
              missing: false,
              size: 128,
              updatedAtMs: 1_700_000_000_000,
            },
          ],
        },
        agentFilesLoading: false,
        agentFilesError: null,
        agentFileActive: "USER.md",
        agentFileContents: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileDrafts: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileSaving: false,
        onLoadFiles: () => undefined,
        onSelectFile: () => undefined,
        onFileDraftChange: () => undefined,
        onFileReset: () => undefined,
        onFileSave: () => undefined,
      }),
      container,
    );

    const dialog = container.querySelector("openclaw-modal-dialog");
    const panel = container.querySelector<HTMLElement>(".md-preview-dialog__panel");
    const expandButton = container.querySelector<HTMLButtonElement>(".md-preview-expand-btn");

    expect(dialog).not.toBeNull();
    expect(panel).toBeInstanceOf(HTMLElement);
    expect(expandButton).toBeInstanceOf(HTMLButtonElement);
    const previewPanel = panel!;
    const previewExpandButton = expandButton!;
    previewExpandButton.click();

    expect([...previewPanel.classList]).toEqual(["md-preview-dialog__panel", "fullscreen"]);
    expect([...previewExpandButton.classList]).toEqual([
      "btn",
      "btn--sm",
      "md-preview-icon-btn",
      "md-preview-expand-btn",
      "is-fullscreen",
    ]);
    expect(previewExpandButton.getAttribute("aria-pressed")).toBe("true");
    expect(previewExpandButton.getAttribute("aria-label")).toBe("Collapse preview");

    container.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')?.click();

    expect([...previewPanel.classList]).toEqual(["md-preview-dialog__panel"]);
    expect([...previewExpandButton.classList]).toEqual([
      "btn",
      "btn--sm",
      "md-preview-icon-btn",
      "md-preview-expand-btn",
    ]);
    expect(previewExpandButton.getAttribute("aria-pressed")).toBe("false");
    expect(previewExpandButton.getAttribute("aria-label")).toBe("Expand preview");
  });
});

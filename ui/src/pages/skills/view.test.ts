/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsListResult, SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { renderSkills } from "./view.ts";

type SkillsProps = Parameters<typeof renderSkills>[0];

const dialogRestores: Array<() => void> = [];

function normalizeText(node: Element | DocumentFragment): string {
  return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function createSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
    bundled: false,
    primaryEnv: "OPENAI_API_KEY",
    emoji: undefined,
    homepage: "https://example.com",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
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
    ...overrides,
  };
}

function createProps(overrides: Partial<SkillsProps> = {}): SkillsProps {
  const report: SkillStatusReport = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: [createSkill()],
  };
  const agentsList: AgentsListResult = {
    defaultId: "main",
    mainKey: "main",
    scope: "project",
    agents: [
      { id: "main", name: "Main" },
      { id: "research", identity: { name: "Research", avatar: "R" } },
    ],
  };

  return {
    connected: true,
    loading: false,
    report,
    agentsList,
    selectedAgentId: "main",
    error: null,
    filter: "",
    statusFilter: "all",
    edits: {},
    operation: null,
    messages: {},
    detailKey: null,
    detailTab: "overview",
    clawhubVerdicts: {},
    clawhubVerdictsLoading: false,
    clawhubVerdictsError: null,
    skillCardContents: {},
    skillCardLoadingKey: null,
    skillCardErrors: {},
    clawhubQuery: "",
    clawhubResults: null,
    clawhubSearchLoading: false,
    clawhubSearchError: null,
    clawhubDetail: null,
    clawhubDetailSlug: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallMessage: null,
    onAgentChange: () => undefined,
    onFilterChange: () => undefined,
    onStatusFilterChange: () => undefined,
    onRefresh: () => undefined,
    onToggle: () => undefined,
    onEdit: () => undefined,
    onSaveKey: () => undefined,
    onInstall: () => undefined,
    onDetailOpen: () => undefined,
    onDetailClose: () => undefined,
    onDetailTabChange: () => undefined,
    onClawHubQueryChange: () => undefined,
    onClawHubDetailOpen: () => undefined,
    onClawHubDetailClose: () => undefined,
    onClawHubInstall: () => undefined,
    ...overrides,
  };
}

describe("renderSkills", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (dialogRestores.length > 0) {
      dialogRestores.pop()?.();
    }
    await i18n.setLocale("en");
  });

  it("renders the agent selector and routes agent changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    const onAgentChange = vi.fn();

    render(
      renderSkills(
        createProps({
          selectedAgentId: "research",
          onAgentChange,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const selector = container.querySelector<
      HTMLElement & {
        options: Array<{ value: string; label: string; badge?: string }>;
        value: string;
        onSelect: (value: string) => void;
        updateComplete: Promise<boolean>;
      }
    >('openclaw-agent-select[name="skills-agent"]');
    const filter = container.querySelector<HTMLInputElement>('input[name="skills-filter"]');
    expect(selector).toBeInstanceOf(HTMLElement);
    expect(filter).toBeInstanceOf(HTMLInputElement);
    await selector?.updateComplete;
    expect(normalizeText(selector!.closest(".plugins-field")!)).toContain("Agent");
    expect(normalizeText(filter!.closest("label")!)).toContain("Search");
    expect(selector?.value).toBe("research");
    expect(selector?.options.map((option) => [option.label, option.badge])).toEqual([
      ["Main (default)", undefined],
      ["Research", undefined],
    ]);
    expect(
      selector?.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar"),
    ).toBe("R");

    selector?.onSelect("main");

    expect(onAgentChange).toHaveBeenCalledWith("main");
  });

  it("localizes the default-agent label", async () => {
    await i18n.setLocale("de");
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    render(renderSkills(createProps()), container);
    const selector = container.querySelector<
      HTMLElement & {
        options: Array<{ value: string; label: string }>;
        updateComplete: Promise<boolean>;
      }
    >('openclaw-agent-select[name="skills-agent"]');
    await selector?.updateComplete;

    expect(selector?.options.find((option) => option.value === "main")?.label).toBe(
      "Main (Standard)",
    );
    expect(selector?.querySelector(".agent-select__trigger")?.getAttribute("aria-label")).toContain(
      "Standard",
    );
  });

  it("renders skill groups as open collapsible sections with heading summaries", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    render(renderSkills(createProps()), container);
    await Promise.resolve();

    const group = container.querySelector<HTMLDetailsElement>("details.skills-group");
    expect(expectDefined(group, "skill group details").open).toBe(true);
    const heading = group?.querySelector("summary h2.settings-section__heading");
    expect(normalizeText(expectDefined(heading, "group summary heading"))).toContain("1");
    expect(normalizeText(group!.querySelector(".settings-group .settings-row")!)).toContain(
      "Repo Skill",
    );
  });

  it("locks every skill mutation control behind the active mutation", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const calendar = createSkill({
      skillKey: "calendar",
      name: "Calendar",
      missing: { bins: ["calendar-cli"], env: [], config: [], os: [] },
      install: [
        { id: "calendar-cli", kind: "brew", label: "Install calendar-cli", bins: ["calendar-cli"] },
      ],
    });
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [createSkill(), calendar],
    };
    const onRefresh = vi.fn();
    const onToggle = vi.fn();
    const onSaveKey = vi.fn();
    const onInstall = vi.fn();
    const onClawHubInstall = vi.fn();

    render(
      renderSkills(
        createProps({
          report,
          detailKey: "calendar",
          operation: { kind: "skill", skillKey: "repo-skill" },
          clawhubResults: [{ score: 1, slug: "github", displayName: "GitHub", version: "1.0.0" }],
          onRefresh,
          onToggle,
          onSaveKey,
          onInstall,
          onClawHubInstall,
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(
      container.querySelector<HTMLElement & { disabled: boolean }>(
        'openclaw-agent-select[name="skills-agent"]',
      )?.disabled,
    ).toBe(true);
    const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Refresh",
    );
    expect(refresh?.disabled).toBe(true);
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement & { disabled: boolean }>(
          "wa-switch.settings-toggle",
        ),
      ).every((toggle) => toggle.hasAttribute("disabled")),
    ).toBe(true);
    expect(
      Array.from(container.querySelectorAll("wa-switch.settings-toggle")).find(
        (toggle) => normalizeText(toggle) === "Repo Skill enabled",
      ),
    ).toBeInstanceOf(HTMLElement);
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.disabled).toBe(
      true,
    );
    const mutationButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => /^(Install|Save key)/.test(normalizeText(button)));
    expect(mutationButtons.length).toBeGreaterThanOrEqual(3);
    expect(mutationButtons.every((button) => button.disabled)).toBe(true);

    refresh?.click();
    for (const toggle of container.querySelectorAll<HTMLElement>("wa-switch.settings-toggle")) {
      toggle.click();
    }
    for (const button of mutationButtons) {
      button.click();
    }
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onSaveKey).not.toHaveBeenCalled();
    expect(onInstall).not.toHaveBeenCalled();
    expect(onClawHubInstall).not.toHaveBeenCalled();
  });

  it("does not transfer toggle state when a skill leaves the disabled tab", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    const passwordSkill = createSkill({ skillKey: "1password", name: "1Password", disabled: true });
    const appleNotesSkill = createSkill({
      skillKey: "apple-notes",
      name: "Apple Notes",
      disabled: true,
    });
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [passwordSkill, appleNotesSkill],
    };

    render(renderSkills(createProps({ report, statusFilter: "disabled" })), container);
    await Promise.resolve();

    const toggles = container.querySelectorAll<HTMLElement & { checked: boolean }>(
      "wa-switch.settings-toggle",
    );
    expect(toggles).toHaveLength(2);
    const passwordToggle = expectDefined(toggles[0], "password skill toggle");
    const appleNotesToggle = expectDefined(toggles[1], "apple notes skill toggle");
    expect(passwordToggle.checked).toBe(false);
    expect(appleNotesToggle.checked).toBe(false);

    // Simulate the user clicking the 1password toggle before the re-render propagates.
    // Without repeat(), Lit's dirty-check skips re-setting `.checked = false` on the reused
    // DOM node, so apple-notes inherits this stale user-driven state.
    passwordToggle.checked = true;

    const updatedReport: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [{ ...passwordSkill, disabled: false }, appleNotesSkill],
    };

    render(
      renderSkills(createProps({ report: updatedReport, statusFilter: "disabled" })),
      container,
    );
    await Promise.resolve();

    const updatedToggles = container.querySelectorAll<HTMLElement & { checked: boolean }>(
      "wa-switch.settings-toggle",
    );
    expect(updatedToggles).toHaveLength(1);
    expect(expectDefined(updatedToggles[0], "updated apple notes skill toggle").checked).toBe(
      false,
    );
  });

  it("treats skills blocked by the selected agent filter as needing setup", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [createSkill({ blockedByAgentFilter: true })],
    };

    render(renderSkills(createProps({ report, statusFilter: "ready" })), container);
    await Promise.resolve();

    expect(container.querySelectorAll(".plugins-item")).toHaveLength(0);
    expect(normalizeText(container)).toContain("Ready 0");
    expect(normalizeText(container)).toContain("Needs Setup 1");

    render(
      renderSkills(createProps({ report, statusFilter: "needs-setup", detailKey: "repo-skill" })),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".plugins-item .settings-status--warn")).not.toBeNull();
    expect(normalizeText(container)).toContain("Reason: blocked by agent filter");
    expect(
      Array.from(container.querySelectorAll(".chip")).map((chip) => normalizeText(chip)),
    ).toContain("blocked");
  });

  it("defers detail dialog opening until the dialog is connected", async () => {
    const container = document.createElement("div");
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      expect(this.isConnected).toBe(true);
      this.setAttribute("open", "");
    });

    installDialogMethod("showModal", showModal);

    render(renderSkills(createProps({ detailKey: "repo-skill" })), container);
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    const { dialog } = await getRenderedModalDialog(container);

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);
  });

  it("opens detail dialogs and routes ClawHub actions", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    const onDetailClose = vi.fn();
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const onClawHubDetailOpen = vi.fn();
    const onClawHubInstall = vi.fn();

    installDialogMethod("showModal", showModal);
    installDialogMethod("close", function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    });

    render(
      renderSkills(
        createProps({
          detailKey: "repo-skill",
          onDetailClose,
        }),
      ),
      container,
    );
    const { dialog } = await getRenderedModalDialog(container);

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);

    const closeButton = container.querySelector<HTMLButtonElement>(
      ".md-preview-dialog__header .btn",
    );
    expect(closeButton).toBeInstanceOf(HTMLButtonElement);
    closeButton!.click();

    expect(onDetailClose).toHaveBeenCalledTimes(1);

    render(
      renderSkills(
        createProps({
          clawhubQuery: "git",
          clawhubResults: [
            {
              score: 0.95,
              slug: "github",
              displayName: "GitHub",
              summary: "GitHub integration for OpenClaw",
              version: "1.2.3",
            },
          ],
          onClawHubDetailOpen,
          onClawHubInstall,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const resultItem = container.querySelector<HTMLElement>(".plugins-item");
    const detailButton = container.querySelector<HTMLButtonElement>(".plugins-item__detail-button");
    const installButton = container.querySelector<HTMLButtonElement>(".plugins-item .btn.btn--sm");
    expect(resultItem).toBeInstanceOf(HTMLElement);
    expect(installButton).toBeInstanceOf(HTMLButtonElement);
    expect(detailButton).toBeInstanceOf(HTMLButtonElement);
    expect(detailButton?.getAttribute("aria-label")).toBe("Open GitHub details");
    expect(detailButton?.contains(installButton)).toBe(false);
    expect(resultItem?.querySelector(".settings-row__title")?.textContent?.trim()).toBe("GitHub");
    expect(resultItem?.querySelector(".settings-row__desc")?.textContent?.trim()).toBe(
      "GitHub integration for OpenClaw",
    );
    expect(resultItem?.querySelector(".settings-row__value")?.textContent?.trim()).toBe("v1.2.3");
    expect(installButton?.textContent?.trim()).toBe("Install");
    detailButton!.click();
    installButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClawHubDetailOpen).toHaveBeenCalledTimes(1);
    expect(onClawHubDetailOpen).toHaveBeenCalledWith("github");
    expect(onClawHubInstall).toHaveBeenCalledTimes(1);
    expect(onClawHubInstall).toHaveBeenCalledWith("github");

    onClawHubInstall.mockClear();
    showModal.mockClear();

    render(
      renderSkills(
        createProps({
          clawhubSearchError: "rate limited",
          clawhubInstallMessage: { kind: "success", text: "Installed github" },
          clawhubDetailSlug: "github",
          clawhubDetail: {
            skill: {
              slug: "github",
              displayName: "GitHub",
              summary: "GitHub integration for OpenClaw",
              createdAt: 1_700_000_000,
              updatedAt: 1_700_000_100,
            },
            latestVersion: {
              version: "1.2.3",
              createdAt: 1_700_000_200,
              changelog: "Added search support",
            },
            metadata: {
              os: ["macos", "linux"],
            },
            owner: {
              displayName: "OpenClaw",
              handle: "openclaw",
            },
          },
          onClawHubInstall,
        }),
      ),
      container,
    );
    await Promise.resolve();

    await vi.waitFor(() => expect(showModal).toHaveBeenCalledTimes(1));
    expect(
      Array.from(container.querySelectorAll(".callout")).map((node) => normalizeText(node)),
    ).toEqual(["rate limited", "Installed github"]);
    expect(normalizeText(container.querySelector(".md-preview-dialog__body")!)).toBe(
      "GitHub integration for OpenClaw By OpenClaw (@openclaw) Latest: v1.2.3 Added search support Platforms: macos, linux Install GitHub",
    );

    const detailInstallButton = container.querySelector<HTMLButtonElement>(
      ".md-preview-dialog__body .btn.primary",
    );
    expect(detailInstallButton).toBeInstanceOf(HTMLButtonElement);
    detailInstallButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClawHubInstall).toHaveBeenCalledTimes(1);
    expect(onClawHubInstall).toHaveBeenCalledWith("github");
  });

  it("renders ClawHub acknowledgement retry actions", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    const onClawHubInstall = vi.fn();

    render(
      renderSkills(
        createProps({
          clawhubInstallMessage: {
            kind: "error",
            text: "REVIEW REQUIRED - ClawHub found suspicious behavior.",
            acknowledgeSlug: "github",
            acknowledgeVersion: "1.2.3",
          },
          onClawHubInstall,
        }),
      ),
      container,
    );

    const retryButton = container.querySelector<HTMLButtonElement>(".callout button");
    expect(normalizeText(container.querySelector(".callout")!)).toBe(
      "REVIEW REQUIRED - ClawHub found suspicious behavior. Acknowledge risk and install",
    );
    expect(retryButton).toBeInstanceOf(HTMLButtonElement);
    retryButton!.click();

    expect(onClawHubInstall).toHaveBeenCalledTimes(1);
    expect(onClawHubInstall).toHaveBeenCalledWith("github", true, "1.2.3");
  });

  it("renders installed ClawHub verdicts and the local Skill Card tab", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    const linkedSkill = createSkill({
      skillKey: "agentreceipt",
      name: "AgentReceipt",
      clawhub: {
        status: "linked",
        valid: true,
        registry: "https://clawhub.ai",
        slug: "agentreceipt",
        installedVersion: "1.2.3",
        installedAt: 123,
      },
      skillCard: {
        present: true,
        path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
        sizeBytes: 30,
      },
    });
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [linkedSkill],
    };
    const verdictKey = "https://clawhub.ai\u0000agentreceipt\u00001.2.3";

    render(
      renderSkills(
        createProps({
          report,
          detailKey: "agentreceipt",
          clawhubVerdicts: {
            [verdictKey]: {
              registry: "https://clawhub.ai",
              ok: false,
              decision: "fail",
              reasons: ["security.suspicious"],
              requestedSlug: "agentreceipt",
              requestedVersion: "1.2.3",
              slug: "agentreceipt",
              version: "1.2.3",
              securityAuditUrl:
                "https://clawhub.ai/openclaw/skills/agentreceipt/security-audit?version=1.2.3",
              securityStatus: "suspicious",
              securityPassed: false,
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(normalizeText(container)).toContain("Review");
    expect(normalizeText(container)).toContain("security.suspicious");
    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="security-audit"]')?.textContent?.trim(),
    ).toBe("Full security report");

    render(
      renderSkills(
        createProps({
          report,
          detailKey: "agentreceipt",
          detailTab: "card",
          skillCardContents: {
            agentreceipt: "# AgentReceipt\n\nLocal **trust** card.",
          },
          clawhubVerdicts: {
            [verdictKey]: {
              registry: "https://clawhub.ai",
              ok: false,
              decision: "fail",
              reasons: ["security.suspicious"],
              requestedSlug: "agentreceipt",
              requestedVersion: "1.2.3",
              securityAuditUrl:
                "https://clawhub.ai/openclaw/skills/agentreceipt/security-audit?version=1.2.3",
              securityStatus: "suspicious",
              securityPassed: false,
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".sidebar-markdown strong")?.textContent).toBe("trust");
    expect(normalizeText(container)).toContain("AgentReceipt Local trust card.");
  });

  it("fails closed for inconsistent ClawHub verdict envelopes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    const linkedSkill = createSkill({
      skillKey: "agentreceipt",
      name: "AgentReceipt",
      clawhub: {
        status: "linked",
        valid: true,
        registry: "https://clawhub.ai",
        slug: "agentreceipt",
        installedVersion: "1.2.3",
        installedAt: 123,
      },
    });
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [linkedSkill],
    };
    const verdictKey = "https://clawhub.ai\u0000agentreceipt\u00001.2.3";

    render(
      renderSkills(
        createProps({
          report,
          detailKey: "agentreceipt",
          clawhubVerdicts: {
            [verdictKey]: {
              registry: "https://clawhub.ai",
              ok: false,
              decision: "pass",
              reasons: [],
              requestedSlug: "agentreceipt",
              requestedVersion: "1.2.3",
              slug: "agentreceipt",
              version: "1.2.3",
              securityStatus: "clean",
              securityPassed: true,
            },
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    const chips = Array.from(container.querySelectorAll(".chip"));
    const verdictChip = chips.find((chip) => normalizeText(chip) === "Unavailable");
    expect(verdictChip).toBeDefined();
    expect(chips.map((chip) => normalizeText(chip))).toContain("Unavailable");
    expect(chips.some((chip) => normalizeText(chip) === "Clean")).toBe(false);
    expect(verdictChip?.classList.contains("chip-ok")).toBe(false);
  });
});

function installDialogMethod(
  name: "showModal" | "close",
  value: (this: HTMLDialogElement) => void,
) {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, {
    configurable: true,
    writable: true,
    value,
  });
  dialogRestores.push(() => {
    if (original) {
      Object.defineProperty(proto, name, original);
      return;
    }
    delete proto[name];
  });
}

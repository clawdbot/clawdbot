/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusReport } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import {
  createDialogMethodInstaller,
  createProps,
  createSkill,
  normalizeText,
} from "./view.test-support.ts";
import { renderSkills } from "./view.ts";

const dialogRestores: Array<() => void> = [];
const installDialogMethod = createDialogMethodInstaller(dialogRestores);

describe("renderSkills", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (dialogRestores.length > 0) {
      dialogRestores.pop()?.();
    }
    await i18n.setLocale("en");
  });

  it("hides the agent selector when only one agent is configured", () => {
    const container = document.createElement("div");
    render(
      renderSkills(
        createProps({
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main", name: "Main" }],
          },
          selectedAgentId: "main",
        }),
      ),
      container,
    );

    expect(container.querySelector('openclaw-agent-select[name="skills-agent"]')).toBeNull();
    expect(container.querySelector('input[name="skills-filter"]')).toBeInstanceOf(HTMLInputElement);
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

  it.each([
    { editValue: "", disabled: true },
    { editValue: "   ", disabled: true },
    { editValue: "  sk-test  ", disabled: false },
  ])(
    "only enables credential replacement for nonblank input: $editValue",
    async ({ editValue, disabled }) => {
      const container = document.createElement("div");
      document.body.append(container);
      dialogRestores.push(() => container.remove());
      installDialogMethod("showModal", function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      });
      const onSaveKey = vi.fn();

      render(
        renderSkills(
          createProps({
            detailKey: "repo-skill",
            edits: { "repo-skill": editValue },
            onSaveKey,
          }),
        ),
        container,
      );
      await Promise.resolve();

      const input = container.querySelector<HTMLInputElement>('input[type="password"]');
      const save = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => normalizeText(button) === "Save key",
      );
      expect(input?.required).toBe(true);
      expect(save?.disabled).toBe(disabled);

      save?.click();

      if (disabled) {
        expect(onSaveKey).not.toHaveBeenCalled();
      } else {
        expect(onSaveKey).toHaveBeenCalledWith("repo-skill");
      }
    },
  );

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

  it("renders alternative missing binaries and exposes their installer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const onInstall = vi.fn();
    const skill = createSkill({
      skillKey: "coding-agent",
      name: "Coding Agent",
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
      install: [
        {
          id: "node-unrelated",
          kind: "node",
          label: "Install unrelated CLI",
          bins: ["unrelated"],
        },
        { id: "node-codex", kind: "node", label: "Install Codex CLI", bins: ["codex"] },
      ],
    });

    render(
      renderSkills(
        createProps({
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [skill],
          },
          detailKey: "coding-agent",
          onInstall,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const warning = container.querySelector(".md-preview-dialog__body .callout");
    expect(normalizeText(expectDefined(warning, "alternative binary requirement"))).toContain(
      "bin:any of (claude, codex, opencode)",
    );
    const installButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => normalizeText(button) === "Install Codex CLI",
    );
    expect(installButton).toBeInstanceOf(HTMLButtonElement);
    installButton?.click();
    expect(onInstall).toHaveBeenCalledWith("coding-agent", "Coding Agent", "node-codex");
  });

  it("does not offer an installer that cannot satisfy a missing alternative", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const skill = createSkill({
      skillKey: "coding-agent",
      name: "Coding Agent",
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
      install: [
        {
          id: "node-unrelated",
          kind: "node",
          label: "Install unrelated CLI",
          bins: ["unrelated"],
        },
      ],
    });

    render(
      renderSkills(
        createProps({
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [skill],
          },
          detailKey: "coding-agent",
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(normalizeText(container)).toContain("bin:any of (claude, codex, opencode)");
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => normalizeText(button) === "Install unrelated CLI",
      ),
    ).toBe(false);
  });

  it("does not offer an installer once an alternative binary is present", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const skill = createSkill({
      skillKey: "coding-agent",
      name: "Coding Agent",
      requirements: {
        bins: [],
        anyBins: ["claude", "codex", "opencode"],
        env: [],
        config: [],
        os: [],
      },
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      install: [{ id: "node-codex", kind: "node", label: "Install Codex CLI", bins: ["codex"] }],
    });

    render(
      renderSkills(
        createProps({
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [skill],
          },
          detailKey: "coding-agent",
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(normalizeText(container)).not.toContain("bin:any of");
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => normalizeText(button) === "Install Codex CLI",
      ),
    ).toBe(false);
  });

  it("keeps update and install permissions independent", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const skill = createSkill({
      missing: { anyBins: [], bins: ["skill-cli"], env: [], config: [], os: [] },
      install: [{ id: "skill-cli", kind: "node", label: "Install skill-cli", bins: ["skill-cli"] }],
    });

    render(
      renderSkills(
        createProps({
          canUpdate: false,
          canInstall: true,
          detailKey: skill.skillKey,
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [skill],
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    expect(
      container.querySelector<HTMLElement>("wa-switch.settings-toggle")?.hasAttribute("disabled"),
    ).toBe(true);
    const install = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => normalizeText(button) === "Install skill-cli",
    );
    expect(install?.disabled).toBe(false);
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
      missing: { anyBins: [], bins: ["calendar-cli"], env: [], config: [], os: [] },
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
});

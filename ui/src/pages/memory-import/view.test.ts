// Control UI tests cover reviewed memory import presentation and selection.
import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { renderMemoryImport } from "./view.ts";

type MemoryImportProps = Parameters<typeof renderMemoryImport>[0];

function createPlan(): NonNullable<MemoryImportProps["plan"]> {
  return {
    agentId: "research",
    workspace: "/tmp/openclaw-research",
    providers: [
      {
        providerId: "codex",
        label: "Codex",
        description: "Import Codex memory.",
        planFingerprint: "a".repeat(64),
        found: true,
        source: "/tmp/codex",
        target: "/tmp/openclaw-research",
        summary: {
          total: 2,
          planned: 2,
          migrated: 0,
          skipped: 0,
          conflicts: 0,
          errors: 0,
          sensitive: 0,
        },
        items: [
          {
            id: "memory:codex:MEMORY.md",
            status: "planned",
            source: "/tmp/codex/memories/MEMORY.md",
            target: "/tmp/openclaw-research/memory/imports/codex/MEMORY.md",
            details: {
              collectionId: "codex",
              collectionLabel: "Codex",
              relativePath: "MEMORY.md",
            },
          },
          {
            id: "memory:codex:memory_summary.md",
            status: "planned",
            source: "/tmp/codex/memories/memory_summary.md",
            target: "/tmp/openclaw-research/memory/imports/codex/memory_summary.md",
            details: {
              collectionId: "codex",
              collectionLabel: "Codex",
              relativePath: "memory_summary.md",
            },
          },
        ],
      },
    ],
  };
}

function createProps(overrides: Partial<MemoryImportProps> = {}): MemoryImportProps {
  return {
    connected: true,
    agents: [{ id: "research", name: "Research" }],
    selectedAgentId: "research",
    plan: createPlan(),
    loading: false,
    error: null,
    applyError: null,
    replaceExisting: false,
    selectedByProvider: {
      codex: ["memory:codex:MEMORY.md", "memory:codex:memory_summary.md"],
    },
    applyingProviderId: null,
    pendingProviderId: null,
    lastResults: {},
    onSelectAgent: vi.fn(),
    onReplaceExisting: vi.fn(),
    onRefresh: vi.fn(),
    onToggleCollection: vi.fn(),
    onRequestImport: vi.fn(),
    onConfirmImport: vi.fn(),
    onCancelImport: vi.fn(),
    ...overrides,
  };
}

describe("renderMemoryImport", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("groups memory by source collection without rendering file contents", () => {
    const plan = createPlan();
    const container = document.createElement("div");
    render(renderMemoryImport(createProps({ plan })), container);

    expect(container.textContent).toContain("MEMORY.md");
    expect(container.textContent).toContain("memory_summary.md");
    expect(container.textContent).toContain("/tmp/openclaw-research/memory/imports/");
    expect(container.textContent).toContain("Consolidated Codex memory files.");
    expect(container.textContent).not.toContain("Import Codex memory.");
    expect(container.textContent).not.toContain("private memory body");
  });

  it("passes the exact collection item ids when selection changes", () => {
    const onToggleCollection = vi.fn();
    const container = document.createElement("div");
    render(renderMemoryImport(createProps({ onToggleCollection })), container);
    const checkbox = container.querySelector<HTMLInputElement>(
      ".memory-import__collection-choice input",
    );
    if (!checkbox) {
      throw new Error("expected collection checkbox");
    }

    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onToggleCollection).toHaveBeenCalledWith(
      "codex",
      ["memory:codex:MEMORY.md", "memory:codex:memory_summary.md"],
      false,
    );
  });

  it("requires confirmation and explains replacement backups", () => {
    const onConfirmImport = vi.fn();
    const container = document.createElement("div");
    render(
      renderMemoryImport(
        createProps({
          pendingProviderId: "codex",
          replaceExisting: true,
          onConfirmImport,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("backed up in the migration report");
    const confirm = container.querySelector<HTMLButtonElement>(
      "[data-test-id='memory-import-confirm']",
    );
    if (!confirm) {
      throw new Error("expected import confirmation button");
    }
    confirm.click();
    expect(onConfirmImport).toHaveBeenCalledOnce();
  });

  it("disables confirmation actions while an import is running", () => {
    const onConfirmImport = vi.fn();
    const onCancelImport = vi.fn();
    const container = document.createElement("div");
    render(
      renderMemoryImport(
        createProps({
          pendingProviderId: "codex",
          applyingProviderId: "codex",
          onConfirmImport,
          onCancelImport,
        }),
      ),
      container,
    );

    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>(".exec-approval-actions button"),
    ];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    buttons[0]?.click();
    expect(onConfirmImport).not.toHaveBeenCalled();
    container
      .querySelector("openclaw-modal-dialog")
      ?.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true }));
    expect(onCancelImport).not.toHaveBeenCalled();

    const refresh = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Refresh",
    );
    expect(refresh?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>("[data-test-id='memory-import-provider-button']")
        ?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>(".memory-import__collection-choice input")
        ?.disabled,
    ).toBe(true);
  });

  it("shows partial import failures with the saved report", () => {
    const plan = createPlan();
    const provider = plan.providers[0];
    if (!provider) {
      throw new Error("expected provider fixture");
    }
    plan.providers[0] = {
      ...provider,
      found: false,
      error: "provider rescan failed",
    };
    const container = document.createElement("div");
    render(
      renderMemoryImport(
        createProps({
          plan,
          lastResults: {
            codex: {
              providerId: "codex",
              source: "/tmp/codex",
              summary: {
                total: 2,
                planned: 0,
                migrated: 1,
                skipped: 0,
                conflicts: 0,
                errors: 1,
                sensitive: 0,
              },
              items: [
                {
                  id: "memory:codex:MEMORY.md",
                  status: "error",
                  target: "/tmp/workspace/memory/imports/codex/MEMORY.md",
                  reason: "replacement interrupted",
                  details: {
                    recoveryPath: "/tmp/workspace/.openclaw-memory-import-staging/MEMORY.md",
                    recoveryRecordPath: "/tmp/migration-report/recovery-required.json",
                    backupPath: "/tmp/migration-report/item-backups/MEMORY.md",
                  },
                },
                {
                  id: "memory:codex:memory_summary.md",
                  status: "migrated",
                  target: "/tmp/workspace/memory/imports/codex/memory_summary.md",
                  details: {
                    recoveryRecordPath: "/tmp/migration-report/recovery-complete.json",
                  },
                },
              ],
              reportDir: "/tmp/migration-report",
            },
          },
        }),
      ),
      container,
    );

    const result = container.querySelector(".memory-import__result--incomplete");
    expect(result?.getAttribute("role")).toBe("alert");
    expect(container.textContent).toContain("provider rescan failed");
    expect(result?.textContent).toContain("Import incomplete");
    expect(result?.textContent).toContain("1 imported · 1 failed · 0 conflicts");
    expect(result?.textContent).toContain("report saved");
    expect(result?.textContent).toContain("/tmp/migration-report");
    expect(result?.textContent).toContain("replacement interrupted");
    expect(result?.textContent).toContain(
      "/tmp/workspace/.openclaw-memory-import-staging/MEMORY.md",
    );
    expect(result?.textContent).toContain("Recovery file");
    expect(result?.textContent).toContain("Recovery journal");
    expect(result?.textContent).toContain("Item backup");
    expect(result?.textContent).toContain("/tmp/migration-report/recovery-required.json");
    expect(result?.textContent).toContain("/tmp/migration-report/item-backups/MEMORY.md");
    expect(result?.textContent).toContain("/tmp/migration-report/recovery-complete.json");
  });
});

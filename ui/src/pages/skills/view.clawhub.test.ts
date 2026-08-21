/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusReport } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { clawhubVerdictKey } from "../../lib/skills/index.ts";
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

describe("renderSkills ClawHub", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (dialogRestores.length > 0) {
      dialogRestores.pop()?.();
    }
    await i18n.setLocale("en");
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
              icon: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
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
    expect(detailButton?.getAttribute("aria-label")).toBe("Open github details");
    expect(detailButton?.contains(installButton)).toBe(false);
    expect(resultItem?.querySelector(".settings-row__title")?.textContent?.trim()).toBe("GitHub");
    expect(resultItem?.querySelector(".settings-row__desc")?.textContent?.trim()).toBe(
      "GitHub integration for OpenClaw · github",
    );
    expect(resultItem?.querySelector(".settings-row__value")?.textContent?.trim()).toBe("v1.2.3");
    expect(resultItem?.querySelector<HTMLImageElement>(".clawhub-skill-icon")?.src).toBe(
      `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
    );
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
          clawhubDetailRef: "github",
          clawhubDetail: {
            skill: {
              slug: "github",
              displayName: "GitHub",
              summary: "GitHub integration for OpenClaw",
              icon: `https://clawhub.ai/api/v1/skill-icons/${"b".repeat(64)}`,
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
    expect(container.querySelector<HTMLImageElement>(".clawhub-skill-icon--detail")?.src).toBe(
      `https://clawhub.ai/api/v1/skill-icons/${"b".repeat(64)}`,
    );
    expect(container.querySelector(".clawhub-skill-icon--profile")).toBeNull();

    const detailInstallButton = container.querySelector<HTMLButtonElement>(
      ".md-preview-dialog__body .btn.primary",
    );
    expect(detailInstallButton).toBeInstanceOf(HTMLButtonElement);
    detailInstallButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClawHubInstall).toHaveBeenCalledTimes(1);
    expect(onClawHubInstall).toHaveBeenCalledWith("github");
  });

  it("routes each same-slug search result to its own publisher", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    const onClawHubDetailOpen = vi.fn();
    const onClawHubInstall = vi.fn();

    render(
      renderSkills(
        createProps({
          clawhubQuery: "imap-smtp-email",
          clawhubResults: ["gzlicanyi", "wangchenyu8"].map((ownerHandle) => ({
            score: 1,
            slug: "imap-smtp-email",
            installRef: `@${ownerHandle}/imap-smtp-email`,
            displayName: "imap-smtp-email",
          })),
          onClawHubDetailOpen,
          onClawHubInstall,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const rows = [...container.querySelectorAll<HTMLElement>(".clawhub-skill-result__button")].map(
      (button) => button.closest<HTMLElement>(".plugins-item")!,
    );
    expect(rows).toHaveLength(2);
    // Rows are otherwise identical, so the reference is what the operator reads and what the
    // row actions must send; a bare slug here is the reported 409 AMBIGUOUS_SKILL_SLUG bug.
    expect(
      rows.map((row) => row.querySelector(".settings-row__desc")?.textContent?.trim()),
    ).toEqual(["@gzlicanyi/imap-smtp-email", "@wangchenyu8/imap-smtp-email"]);

    for (const row of rows) {
      row.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
      row
        .querySelector<HTMLButtonElement>(".btn.btn--sm")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    expect(onClawHubDetailOpen.mock.calls.flat()).toEqual([
      "@gzlicanyi/imap-smtp-email",
      "@wangchenyu8/imap-smtp-email",
    ]);
    expect(onClawHubInstall.mock.calls.flat()).toEqual([
      "@gzlicanyi/imap-smtp-email",
      "@wangchenyu8/imap-smtp-email",
    ]);
  });

  it("offers install without a detail card for an install-only search result", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    const onClawHubDetailOpen = vi.fn();
    const onClawHubInstall = vi.fn();

    render(
      renderSkills(
        createProps({
          clawhubQuery: "pdf",
          clawhubResults: [
            {
              score: 1,
              slug: "pdf",
              // The Gateway marks external sources install-only; it serves no card for them.
              installRef: "skills-sh:openai/skills/pdf",
              installOnly: true,
              trustState: "not-scanned-by-clawhub",
              displayName: "Pdf",
            },
            {
              score: 1,
              slug: "pdf",
              installRef: "@awspace/pdf",
              displayName: "Pdf",
            },
          ],
          onClawHubDetailOpen,
          onClawHubInstall,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const rows = [...container.querySelectorAll<HTMLElement>(".clawhub-skill-result__button")].map(
      (copy) => copy.closest<HTMLElement>(".plugins-item")!,
    );
    expect(rows).toHaveLength(2);
    // A detail button on the external row would open a dialog the Gateway always refuses.
    expect(rows[0]!.querySelector(".plugins-item__detail-button")).toBeNull();
    expect(rows[1]!.querySelector(".plugins-item__detail-button")).not.toBeNull();
    // The row is the only place left to say the source was never scanned.
    expect(rows[0]!.querySelector(".settings-row__desc")?.textContent).toContain(
      "Not scanned by ClawHub",
    );

    for (const row of rows) {
      row
        .querySelector<HTMLButtonElement>(".btn.btn--sm")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    // Install keeps the exact source the operator picked instead of a same-slug native skill.
    expect(onClawHubInstall.mock.calls.flat()).toEqual([
      "skills-sh:openai/skills/pdf",
      "@awspace/pdf",
    ]);
    expect(onClawHubDetailOpen).not.toHaveBeenCalled();
  });

  it("renders an installed external result from its exact recorded reference", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    const onClawHubInstall = vi.fn();

    render(
      renderSkills(
        createProps({
          clawhubQuery: "pdf",
          clawhubResults: [
            {
              score: 1,
              slug: "pdf",
              installRef: "skills-sh:openai/skills/pdf",
              installOnly: true,
              displayName: "Pdf",
            },
          ],
          report: {
            workspaceDir: "/tmp/workspace",
            managedSkillsDir: "/tmp/skills",
            skills: [
              createSkill({
                clawhub: {
                  status: "linked",
                  valid: true,
                  registry: "https://clawhub.ai",
                  slug: "pdf",
                  requestedReference: "skills-sh:openai/skills/pdf",
                  installedVersion: "0.0.0",
                  installedAt: 1,
                },
              }),
            ],
          },
          onClawHubInstall,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const button = container.querySelector<HTMLButtonElement>(".btn.btn--sm")!;
    expect(button.textContent?.trim()).toBe("Installed");
    expect(button.disabled).toBe(true);
    button.click();
    expect(onClawHubInstall).not.toHaveBeenCalled();
  });

  it("keeps the review flow for results from a gateway that predates the install-only flag", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());
    const onClawHubDetailOpen = vi.fn();

    render(
      renderSkills(
        createProps({
          clawhubQuery: "email",
          // An older gateway sends installRef with no capability field at all.
          clawhubResults: [
            { score: 1, slug: "email", installRef: "@alice/email", displayName: "Email" },
          ],
          onClawHubDetailOpen,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const row = container
      .querySelector<HTMLElement>(".clawhub-skill-result__button")!
      .closest<HTMLElement>(".plugins-item")!;
    // Reading omission as install-only would silently drop the reviewed-version step that every
    // released gateway still expects.
    const detailButton = row.querySelector<HTMLButtonElement>(".plugins-item__detail-button");
    expect(detailButton).not.toBeNull();
    detailButton!.click();
    expect(onClawHubDetailOpen).toHaveBeenCalledWith("@alice/email");
  });

  it("sizes the ClawHub detail dialog to a refusal message instead of a reader", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    render(
      renderSkills(
        createProps({
          clawhubDetailRef: "skills-sh:acme/tools/imap-smtp-email",
          clawhubDetailError:
            "ClawHub cannot return details for skills-sh:acme/tools/imap-smtp-email; external skill sources are install-only.",
        }),
      ),
      container,
    );
    await Promise.resolve();

    // Without this the panel keeps the tall reader height meant for skill documents, so a
    // two-line refusal renders in a mostly empty dialog and reads as broken.
    expect(container.querySelectorAll(".md-preview-dialog__panel--message-only")).toHaveLength(1);
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
            acknowledgeRef: "github",
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
        ownerHandle: "openclaw",
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
    const verdictKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      ownerHandle: "openclaw",
      version: "1.2.3",
    });
    const onDetailTabChange = vi.fn();

    render(
      renderSkills(
        createProps({
          report,
          detailKey: "agentreceipt",
          onDetailTabChange,
          clawhubVerdicts: {
            [verdictKey]: {
              registry: "https://clawhub.ai",
              ok: false,
              decision: "fail",
              reasons: ["security.suspicious"],
              requestedSlug: "agentreceipt",
              requestedOwnerHandle: "openclaw",
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
    expect(normalizeText(container)).toContain("@openclaw/agentreceipt@1.2.3");
    expect(normalizeText(container)).toContain("security.suspicious");
    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="security-audit"]')?.textContent?.trim(),
    ).toBe("Full security report");
    expect(container.querySelector("#skill-detail-tab-overview")?.hasAttribute("active")).toBe(
      true,
    );
    container
      .querySelector("#skill-detail-tab-card")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(onDetailTabChange).toHaveBeenCalledWith("card");

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
              requestedOwnerHandle: "openclaw",
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

    expect(container.querySelector("#skill-detail-tab-card")?.hasAttribute("active")).toBe(true);
    expect(container.querySelector(".sidebar-markdown strong")?.textContent).toBe("trust");
    expect(normalizeText(container)).toContain("AgentReceipt Local trust card.");
  });

  it.each([
    { loading: true, label: "Refreshing…", warning: false },
    { loading: false, label: "Unavailable", warning: true },
  ])(
    "shows $label consistently for a missing ClawHub verdict while loading=$loading",
    async ({ loading, label, warning }) => {
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
      render(
        renderSkills(
          createProps({
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [linkedSkill],
            },
            detailKey: "agentreceipt",
            clawhubVerdictsLoading: loading,
          }),
        ),
        container,
      );
      await Promise.resolve();

      const rowVerdict = Array.from(container.querySelectorAll(".settings-status")).find(
        (element) => normalizeText(element) === label,
      );
      const detailVerdict = Array.from(container.querySelectorAll(".chip")).find(
        (element) => normalizeText(element) === label,
      );
      expect(rowVerdict).toBeDefined();
      expect(detailVerdict).toBeDefined();
      expect(rowVerdict?.classList.contains("settings-status--warn")).toBe(warning);
      expect(detailVerdict?.classList.contains("chip-warn")).toBe(warning);
      expect(normalizeText(container).match(new RegExp(label, "gu")) ?? []).toHaveLength(2);
    },
  );

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
    const verdictKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      version: "1.2.3",
    });

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

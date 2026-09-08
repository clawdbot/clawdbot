import { afterEach, describe, expect, it, vi } from "vitest";
import { computeLineDiff } from "../../lib/chat/tool-call-diff.ts";
import { createSkillWorkshopState, skillWorkshopRouteData } from "./proposals.ts";
import {
  createContext,
  type SkillWorkshopPageTestElement,
} from "./skill-workshop-page.test-support.ts";
import "./skill-workshop-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.removeItem("openclaw:control-ui:skill-workshop-mode:v1");
});

describe("Workshop installed comparisons", () => {
  it.each([
    {
      previous: "Keep the existing check.",
      current: "Keep the existing check.\nCheck rollback before release.",
      shortened: false,
      lateOnly: false,
    },
    {
      previous: "Keep the existing check.",
      current: [
        "Keep the existing check.",
        ...Array.from({ length: 450 }, (_, index) => `Check release item ${index + 1}.`),
      ].join("\n"),
      shortened: true,
      lateOnly: false,
    },
    {
      previous: Array.from({ length: 700 }, (_, index) => `Check release item ${index + 1}.`).join(
        "\n",
      ),
      current: Array.from({ length: 700 }, (_, index) =>
        index === 649 ? "Late-only instruction change." : `Check release item ${index + 1}.`,
      ).join("\n"),
      shortened: true,
      lateOnly: true,
    },
    {
      previous: Array.from({ length: 700 }, (_, index) => `Check release item ${index + 1}.`).join(
        "\n",
      ),
      current: Array.from({ length: 700 }, (_, index) =>
        index === 9
          ? "Early instruction change."
          : index === 649
            ? "Mixed late instruction change."
            : `Check release item ${index + 1}.`,
      ).join("\n"),
      shortened: true,
      lateOnly: false,
    },
  ])(
    "opens the differing saved comparison (shortened=$shortened, lateOnly=$lateOnly)",
    async ({ previous, current, shortened, lateOnly }) => {
      localStorage.setItem("openclaw:control-ui:skill-workshop-mode:v1", "skills");
      const state = createSkillWorkshopState();
      state.skillWorkshopAgentId = "research";
      state.skillWorkshopLoaded = true;
      state.skillWorkshopInstalledName = "release-review";
      state.skillWorkshopInstalledSkills = [
        {
          name: "unchanged-skill",
          skillKey: "unchanged-skill",
          description: "No changes",
          read: {
            status: "ready",
            name: "unchanged-skill",
            content: "Keep this instruction.",
            savedVersions: [
              {
                key: "unchanged",
                diff: computeLineDiff("Keep this instruction.", "Keep this instruction."),
              },
            ],
          },
        },
        {
          name: "release-review",
          skillKey: "release-review",
          description: "Release checks",
          read: {
            status: "ready",
            name: "release-review",
            content: current,
            savedVersions: [
              {
                key: "newest",
                appliedAt: "2026-08-17T10:00:00.000Z",
                diff: computeLineDiff(current, current, { compactUnchanged: true }),
              },
              {
                key: "older",
                appliedAt: "2026-08-16T10:00:00.000Z",
                diff: computeLineDiff(previous, current, {
                  compactUnchanged: true,
                }),
              },
            ],
          },
        },
      ];
      const page = document.createElement(
        "openclaw-skill-workshop-page",
      ) as SkillWorkshopPageTestElement;
      page.data = skillWorkshopRouteData(state);
      page.context = createContext(vi.fn());
      document.body.append(page);
      await page.updateComplete;

      const reader = page.querySelector(".sw-collection__reader");
      expect(page.querySelector(".sw-installed-skill__name")?.textContent).toBe("release-review");
      expect(page.querySelector(".sw-installed-skill__change")?.textContent).toContain(
        "Changed since",
      );
      const versions = reader?.querySelectorAll("details");
      expect(versions?.[0]?.open).toBe(false);
      expect(versions?.[1]?.open).toBe(true);
      expect(reader?.textContent).toContain(
        lateOnly
          ? "Late-only instruction change."
          : shortened
            ? "Check release item 1."
            : "Check rollback before release.",
      );
      expect(reader?.querySelector(".sidebar-markdown") !== null).toBe(shortened);
      expect(
        reader?.textContent?.includes("This diff is shortened. Some changes may not be shown."),
      ).toBe(shortened);
    },
  );
});

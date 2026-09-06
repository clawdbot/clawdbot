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
    { current: "Keep the existing check.\nCheck rollback before release.", shortened: false },
    {
      current: [
        "Keep the existing check.",
        ...Array.from({ length: 450 }, (_, index) => `Check release item ${index + 1}.`),
      ].join("\n"),
      shortened: true,
    },
  ])(
    "opens the differing saved comparison and labels shortening: $shortened",
    async ({ current, shortened }) => {
      localStorage.setItem("openclaw:control-ui:skill-workshop-mode:v1", "skills");
      const state = createSkillWorkshopState();
      state.skillWorkshopAgentId = "research";
      state.skillWorkshopLoaded = true;
      state.skillWorkshopInstalledName = "release-review";
      state.skillWorkshopInstalledSkills = [
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
                diff: computeLineDiff("Keep the existing check.", current, {
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
      const versions = reader?.querySelectorAll("details");
      expect(versions?.[0]?.open).toBe(false);
      expect(versions?.[1]?.open).toBe(true);
      expect(versions?.[1]?.textContent).toContain(
        shortened ? "Check release item 1." : "Check rollback before release.",
      );
      expect(reader?.querySelector(".sidebar-markdown")).toBeNull();
      expect(
        reader?.textContent?.includes("This diff is shortened. Some changes may not be shown."),
      ).toBe(shortened);
    },
  );
});

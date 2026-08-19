import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SkillWorkshopRouteData } from "./proposals.ts";

export const page = definePage({
  ...routePageSpec("skill-workshop"),
  component: () =>
    import("./skill-workshop-page.ts").then(() => ({
      render: (data: unknown) => html`
        <openclaw-skill-workshop-page
          .data=${data as SkillWorkshopRouteData | undefined}
        ></openclaw-skill-workshop-page>
      `,
    })),
  loader: async (context: ApplicationContext) => {
    const [{ loadSkillWorkshopPageData }, { createSkillWorkshopState, skillWorkshopRouteData }] =
      await Promise.all([import("./history-scan-page-controller.ts"), import("./proposals.ts")]);
    const state = createSkillWorkshopState();
    await loadSkillWorkshopPageData({ state, context, force: true });
    return skillWorkshopRouteData(state);
  },
});

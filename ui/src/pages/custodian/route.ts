import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import type { ApplicationContext } from "../../app/context.ts";
import { resolveOnboardingMode } from "../../app/onboarding-mode.ts";

export type CustodianRouteData = {
  onboarding: boolean;
  intent: "new-agent" | null;
};

function resolveCustodianIntent(search: string): CustodianRouteData["intent"] {
  return new URLSearchParams(search).get("intent") === "new-agent" ? "new-agent" : null;
}

export const page = definePage({
  id: "custodian",
  path: "/custodian",
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) => location.search,
  loader: (_context: ApplicationContext, { location }): CustodianRouteData => ({
    onboarding: resolveOnboardingMode(location.search),
    intent: resolveCustodianIntent(location.search),
  }),
  component: () =>
    import("./custodian-page.ts").then(() =>
      import("./route-view.ts").then(({ renderCustodianRoute }) => ({
        header: true,
        render: (data: CustodianRouteData | undefined) => renderCustodianRoute(data),
      })),
    ),
});

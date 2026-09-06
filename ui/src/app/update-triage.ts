import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationContext } from "./context.ts";
import type { UpdateFailureTriage, UpdateTriageAdmission } from "./update-overlay-helpers.ts";

/** Failure guidance stays in the loaded update owner even if retired chunks cannot load. */
export async function openUpdateFailureTriage(
  context: ApplicationContext<NavigationRouteId>,
  failure: UpdateFailureTriage,
  admission: UpdateTriageAdmission,
): Promise<void> {
  try {
    const { presentUpdateFailureTriage } = await import("./update-triage.runtime.ts");
    presentUpdateFailureTriage(context, failure, admission);
  } catch {
    if (admission.isCurrent()) {
      context.navigate("updates");
    }
  }
}

import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { navigateWithRouteTransition } from "../../app/route-transition.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

type StartedSession = {
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  key: string;
  agentId: string;
};

/** A committed create is retried as navigation, never as a second create. */
export class StartedSessionNavigation {
  current: StartedSession | null = null;

  isCurrent(context: ApplicationContext | undefined, agentId: string): boolean {
    const started = this.current;
    const snapshot = context?.gateway.snapshot;
    return Boolean(
      started &&
      snapshot?.phase === "connected" &&
      snapshot.client === started.client &&
      snapshot.sessionKey === started.key &&
      normalizeAgentId(agentId) === started.agentId,
    );
  }

  async navigate(context: ApplicationContext, started: StartedSession): Promise<void> {
    this.current = started;
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey: started.key,
      agentId: started.agentId,
    });
    const options = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey: started.key,
      agentId: started.agentId,
      focusComposer: true,
    }).options;
    await navigateWithRouteTransition({
      document,
      from: "new-session",
      to: "chat",
      prefersReducedMotion:
        globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      prepare: () => context.preload("chat", options),
      navigate: () => context.navigateAndWait("chat", options),
    });
    if (this.current === started) {
      this.current = null;
    }
  }
}

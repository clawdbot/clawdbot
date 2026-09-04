import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { navigateWithRouteTransition } from "../../app/route-transition.ts";
import { prepareSessionNavigationHandoff } from "../../lib/sessions/navigation-handoff.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";

type StartedSession = {
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  hello: ApplicationContext["gateway"]["snapshot"]["hello"];
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
      snapshot.hello === started.hello &&
      snapshot.sessionKey === started.key &&
      normalizeAgentId(agentId) === started.agentId,
    );
  }

  async navigate(
    context: ApplicationContext,
    started: Omit<StartedSession, "hello">,
  ): Promise<void> {
    const current = { ...started, hello: context.gateway.snapshot.hello };
    this.current = current;
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
      navigationKey: started.key,
    }).options;
    await navigateWithRouteTransition({
      document,
      from: "new-session",
      to: "chat",
      prefersReducedMotion:
        globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      navigate: () => {
        if (this.current !== current || !this.isCurrent(context, started.agentId)) {
          throw new DOMException("Session navigation interrupted", "AbortError");
        }
        // Carry the confirmed key through the same connection's short route;
        // neither the background roster nor another lookup needs to finish.
        prepareSessionNavigationHandoff(context.gateway, options.pathname, started.key);
        return context.navigateAndWait("chat", options);
      },
    });
    if (this.current === current) {
      this.current = null;
    }
  }
}

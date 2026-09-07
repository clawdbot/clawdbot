import { consume } from "@lit/context";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { IdentityAvatarController } from "../../lib/identity-avatar-loader.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { rosterActivityStore } from "./roster-activity-store.ts";

export abstract class AgentRosterElement extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  protected context!: ApplicationContext;

  protected readonly avatars = new IdentityAvatarController(this);
  constructor() {
    super();
    new SubscriptionsController(this).watch(
      () => this.context && rosterActivityStore(this.context),
      (store, notify) => store.subscribe(notify),
    );
  }

  protected get roster() {
    return rosterActivityStore(this.context).snapshot;
  }

  protected get connected() {
    return this.context.gateway.snapshot.phase === "connected";
  }

  protected refresh(): Promise<void> {
    return rosterActivityStore(this.context).refresh();
  }

  protected cards() {
    return this.roster.cards.map((card) =>
      Object.assign({}, card, {
        avatar: card.avatar ? this.avatars.resolve(card.avatar) : null,
        target: sessionNavigationTarget({
          context: this.context,
          face: "chat",
          sessionKey: card.mainKey,
          agentId: card.id,
        }),
      }),
    );
  }
}

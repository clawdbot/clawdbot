type GatewayEventListener<TEvent> = (event: TEvent) => void;

/** Subscription identity prevents old frames and disposers from reviving callbacks. */
export class GatewayEventListeners<TEvent> {
  private readonly listeners = new Map<GatewayEventListener<TEvent>, object>();

  add(listener: GatewayEventListener<TEvent>): () => void {
    const subscription = this.listeners.get(listener) ?? {};
    this.listeners.set(listener, subscription);
    return () => {
      if (this.listeners.get(listener) === subscription) {
        this.listeners.delete(listener);
      }
    };
  }

  snapshot(): Array<[GatewayEventListener<TEvent>, object]> {
    return [...this.listeners];
  }

  isCurrent(listener: GatewayEventListener<TEvent>, subscription: object): boolean {
    return this.listeners.get(listener) === subscription;
  }
}

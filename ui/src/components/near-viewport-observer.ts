export class NearViewportObserver {
  private observer?: IntersectionObserver;
  nearVisible = false;
  target?: Element;

  constructor(
    private readonly marginPx: number,
    private readonly visibilityChanged: () => void,
  ) {}

  observe(target: Element): void {
    if (target === this.target) {
      return;
    }
    this.disconnect();
    this.target = target;
    this.setNearVisible(this.isNearViewport(target));
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry || entry.target !== this.target) {
          return;
        }
        this.setNearVisible(entry.isIntersecting || this.isNearViewport(entry.target));
      },
      { rootMargin: `${this.marginPx}px 0px` },
    );
    this.observer.observe(target);
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.target = undefined;
    this.setNearVisible(false);
  }

  private setNearVisible(nearVisible: boolean): void {
    if (nearVisible !== this.nearVisible) {
      this.nearVisible = nearVisible;
      this.visibilityChanged();
    }
  }

  private isNearViewport(target: Element): boolean {
    const bounds = target.getBoundingClientRect();
    return bounds.bottom >= -this.marginPx && bounds.top <= window.innerHeight + this.marginPx;
  }
}

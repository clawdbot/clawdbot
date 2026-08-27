const CARD_GAP = 10;
const VIEWPORT_PADDING = 12;

type PortaledHovercardPlacement = "horizontal" | "vertical";

export class PortaledHovercardController {
  card: HTMLDivElement | null = null;
  pointerInside = false;
  pointerOverCard = false;
  focusInside = false;
  cardFocusInside = false;

  private closeTimer: number | null = null;
  private exitCleanup: (() => void) | null = null;
  private anchor: HTMLElement | null = null;
  private openTimer: number | null = null;
  private placement: PortaledHovercardPlacement = "vertical";
  private stopPositioning: (() => void) | null = null;
  private trigger: HTMLElement | null = null;
  private unmountContents: (() => void) | null = null;

  constructor(
    private readonly close: () => void,
    private readonly closeDelayMs = 120,
  ) {}

  get held(): boolean {
    return this.pointerInside || this.pointerOverCard || this.focusInside || this.cardFocusInside;
  }

  scheduleOpen(delay: number, open: () => void): void {
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      open();
    }, delay);
  }

  clearClose(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  scheduleClose(delayMs = this.closeDelayMs): void {
    this.clearClose();
    if (this.held) {
      return;
    }
    // A pending open has no portal gap to cross, so it closes immediately.
    if (!this.card) {
      this.close();
      return;
    }
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      if (!this.held) {
        this.close();
      }
    }, delayMs);
  }

  markTrigger(trigger: HTMLElement): void {
    this.trigger = trigger;
    markPortaledHovercardTrigger(trigger);
  }

  mount(
    anchor: HTMLElement,
    card: HTMLDivElement,
    placement: PortaledHovercardPlacement,
    observeVisualViewport = true,
    unmountContents?: () => void,
  ): void {
    this.clearCard();
    this.anchor = anchor;
    this.card = card;
    this.placement = placement;
    this.unmountContents = unmountContents ?? null;
    this.stopPositioning = mountPortaledHovercard({
      anchor,
      trigger: this.trigger ?? anchor,
      card,
      placement,
      observeVisualViewport,
    });
  }

  clearCard(exitDurationMs = 0): void {
    this.stopPositioning?.();
    this.stopPositioning = null;
    this.exitCleanup?.();
    this.exitCleanup = null;
    const card = this.card;
    const unmountContents = this.unmountContents;
    this.card = null;
    this.unmountContents = null;
    if (!card) {
      return;
    }
    if (exitDurationMs <= 0 || !card.isConnected) {
      unmountContents?.();
      card.remove();
      return;
    }
    card.dataset.open = "false";
    card.style.pointerEvents = "none";
    let exitTimer: number | null = null;
    const finish = () => {
      if (exitTimer !== null) {
        window.clearTimeout(exitTimer);
        exitTimer = null;
      }
      card.removeEventListener("transitionend", handleTransitionEnd);
      unmountContents?.();
      card.remove();
      if (this.exitCleanup === finish) {
        this.exitCleanup = null;
      }
    };
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target === card && event.propertyName === "opacity") {
        finish();
      }
    };
    card.addEventListener("transitionend", handleTransitionEnd);
    exitTimer = window.setTimeout(finish, exitDurationMs + 50);
    this.exitCleanup = finish;
  }

  position(): void {
    if (this.anchor && this.card) {
      positionPortaledHovercard(this.anchor, this.card, this.placement);
    }
  }

  reset(exitDurationMs = 0): void {
    if (this.openTimer !== null) {
      window.clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.clearClose();
    this.pointerInside = false;
    this.pointerOverCard = false;
    this.focusInside = false;
    this.cardFocusInside = false;
    clearPortaledHovercardTrigger(this.trigger);
    this.clearCard(exitDurationMs);
    this.anchor = null;
    this.trigger = null;
  }
}

function markPortaledHovercardTrigger(trigger: HTMLElement): void {
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
}

function clearPortaledHovercardTrigger(trigger: HTMLElement | null): void {
  trigger?.removeAttribute("aria-controls");
  trigger?.removeAttribute("aria-expanded");
  trigger?.removeAttribute("aria-haspopup");
}

export function createPortaledHovercard(id: string, className: string): HTMLDivElement {
  const card = document.createElement("div");
  card.id = id;
  card.className = className;
  card.dataset.open = "true";
  card.setAttribute("role", "dialog");
  return card;
}

function mountPortaledHovercard(params: {
  anchor: HTMLElement;
  trigger: HTMLElement;
  card: HTMLDivElement;
  placement: PortaledHovercardPlacement;
  observeVisualViewport?: boolean;
}): () => void {
  document.body.append(params.card);
  params.trigger.setAttribute("aria-controls", params.card.id);
  params.trigger.setAttribute("aria-expanded", "true");
  const position = () => positionPortaledHovercard(params.anchor, params.card, params.placement);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);
  if (params.observeVisualViewport !== false) {
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
  }
  position();
  return () => {
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", position, true);
    window.visualViewport?.removeEventListener("resize", position);
    window.visualViewport?.removeEventListener("scroll", position);
  };
}

function positionPortaledHovercard(
  anchor: HTMLElement,
  card: HTMLDivElement,
  placement: PortaledHovercardPlacement,
): void {
  const anchorRect = anchor.getBoundingClientRect();
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  const maxLeft = Math.max(VIEWPORT_PADDING, innerWidth - cardWidth - VIEWPORT_PADDING);
  const maxTop = Math.max(VIEWPORT_PADDING, innerHeight - cardHeight - VIEWPORT_PADDING);
  if (placement === "horizontal") {
    const fitsRight = anchorRect.right + CARD_GAP + cardWidth + VIEWPORT_PADDING <= innerWidth;
    const left = fitsRight ? anchorRect.right + CARD_GAP : anchorRect.left - cardWidth - CARD_GAP;
    card.dataset.side = fitsRight ? "right" : "left";
    card.style.left = `${Math.min(Math.max(VIEWPORT_PADDING, left), maxLeft)}px`;
    card.style.top = `${Math.min(Math.max(VIEWPORT_PADDING, anchorRect.top), maxTop)}px`;
    return;
  }
  const fitsBelow = anchorRect.bottom + CARD_GAP + cardHeight + VIEWPORT_PADDING <= innerHeight;
  const side = fitsBelow ? "bottom" : "top";
  const top = fitsBelow ? anchorRect.bottom + CARD_GAP : anchorRect.top - cardHeight - CARD_GAP;
  card.dataset.side = side;
  card.style.left = `${Math.min(Math.max(VIEWPORT_PADDING, anchorRect.left), maxLeft)}px`;
  card.style.top = `${Math.min(Math.max(VIEWPORT_PADDING, top), maxTop)}px`;
}

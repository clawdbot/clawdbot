import type { ReactiveController, ReactiveControllerHost } from "lit";

type ComposerGutterHost = ReactiveControllerHost & ParentNode;

/**
 * Tracks the free space between the centered composer and one pane edge.
 * Measured from the DOM rather than derived from the pane width: the transcript
 * width is a user setting in arbitrary CSS units, and an open side panel shrinks
 * the conversation column without changing the pane. The progress card docks
 * into that gutter once it fits.
 */
export class ComposerGutterController implements ReactiveController {
  private observer: ResizeObserver | null = null;
  private targets: readonly Element[] = [];
  private measured = 0;

  constructor(private readonly host: ComposerGutterHost) {
    host.addController(this);
  }

  get width(): number {
    return this.measured;
  }

  hostUpdated(): void {
    if (typeof ResizeObserver !== "function") {
      return;
    }
    const shell = this.host.querySelector<HTMLElement>(".agent-chat__composer-shell");
    const conversation = shell?.parentElement ?? null;
    const targets = shell && conversation ? [conversation, shell] : [];
    const unchanged =
      targets.length === this.targets.length &&
      targets.every((target, index) => target === this.targets[index]);
    if (unchanged) {
      return;
    }
    this.observer?.disconnect();
    this.targets = targets;
    if (targets.length === 0) {
      return;
    }
    // Both edges move the gutter: the conversation column follows the side
    // panel, and the composer itself resizes with the transcript-width setting.
    this.observer ??= new ResizeObserver(() => this.measure());
    for (const target of targets) {
      this.observer.observe(target);
    }
  }

  hostDisconnected(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.targets = [];
  }

  private measure(): void {
    const shell = this.targets[1];
    const conversation = this.targets[0];
    if (!(shell instanceof HTMLElement) || !(conversation instanceof HTMLElement)) {
      return;
    }
    const conversationWidth = conversation.clientWidth;
    // Hidden panes (split view, pane cache) report 0; keep the last real width.
    if (conversationWidth <= 0) {
      return;
    }
    const gutter = Math.max(0, Math.round((conversationWidth - shell.clientWidth) / 2));
    if (gutter === this.measured) {
      return;
    }
    this.measured = gutter;
    this.host.requestUpdate();
  }
}

import type { ReactiveController, ReactiveControllerHost } from "lit";
import { trackDropdownKeyboardDismissal } from "./web-awesome.ts";

type DropdownMenuHost = ReactiveControllerHost & HTMLElement;

export class DropdownMenuController implements ReactiveController {
  private generation = 0;

  constructor(
    private readonly host: DropdownMenuHost,
    private readonly options: {
      getTrigger: () => HTMLElement | null;
      onClose: () => void;
      onKeydown?: (event: KeyboardEvent) => void;
    },
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    document.addEventListener("keydown", this.handleDocumentKeydown, true);
    const generation = ++this.generation;
    void this.focusFirstItem(generation);
  }

  hostDisconnected(): void {
    this.generation += 1;
    document.removeEventListener("keydown", this.handleDocumentKeydown, true);
  }

  private readonly handleDocumentKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") {
      // Nested dialogs and outside targets own their own Tab order; only menu
      // items need the durable trigger before Web Awesome dismisses them.
      if (
        event.key === "Tab" &&
        event
          .composedPath()
          .some(
            (target) =>
              target instanceof Element &&
              target.localName === "wa-dropdown-item" &&
              this.host.contains(target),
          )
      ) {
        trackDropdownKeyboardDismissal(event, () => this.options.getTrigger()?.focus());
      }
      this.options.onKeydown?.(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.options.getTrigger()?.focus();
    this.options.onClose();
  };

  private async focusFirstItem(generation: number): Promise<void> {
    await this.host.updateComplete;
    const dropdown = this.host.querySelector<HTMLElement & { updateComplete?: Promise<unknown> }>(
      "wa-dropdown",
    );
    await dropdown?.updateComplete;
    if (this.host.isConnected && generation === this.generation) {
      this.host.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])")?.focus();
    }
  }
}

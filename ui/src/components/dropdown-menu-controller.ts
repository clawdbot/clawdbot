import type { ReactiveController, ReactiveControllerHost } from "lit";

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

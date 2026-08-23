import type { BoardWidget, BoardWidgetAppViewResult } from "@openclaw/gateway-protocol";
import type { BoardWidgetAppViewState } from "./view-types.ts";

type AppViewRequest = () => Promise<BoardWidgetAppViewResult>;

export class BoardMcpAppViewCache {
  private readonly entries = new Map<
    string,
    Promise<BoardWidgetAppViewState> | BoardWidgetAppViewState
  >();

  clear(): void {
    this.entries.clear();
  }

  prune(widgets: readonly BoardWidget[]): void {
    const validKeys = new Set(
      widgets
        .filter((widget) => widget.contentKind === "mcp-app")
        .map((widget) => this.key(widget)),
    );
    for (const key of this.entries.keys()) {
      if (!validKeys.has(key)) {
        this.entries.delete(key);
      }
    }
  }

  async resolve(
    widget: BoardWidget,
    request: AppViewRequest,
    force: boolean,
  ): Promise<BoardWidgetAppViewState> {
    const key = this.key(widget);
    if (force) {
      this.entries.delete(key);
    }
    const cached = this.entries.get(key);
    if (cached) {
      return await cached;
    }
    const pending = request()
      .then<BoardWidgetAppViewState>((result) => ({ status: "ready", ...result }))
      .catch<BoardWidgetAppViewState>((error: unknown) => ({
        status: "stale",
        error: error instanceof Error ? error.message : String(error),
      }));
    this.entries.set(key, pending);
    const resolved = await pending;
    if (this.entries.get(key) === pending) {
      this.entries.set(key, resolved);
    }
    return resolved;
  }

  private key(widget: BoardWidget): string {
    return `${widget.name}\0${widget.revision}\0${widget.instanceId ?? ""}\0${widget.grantState}`;
  }
}

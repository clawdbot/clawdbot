import { AsyncDirective, directive } from "lit/async-directive.js";
import type { DiffFilePaths, DiffLine } from "../../../lib/chat/tool-call-diff.ts";

type RenderDiff = (renderLine: (line: DiffLine) => unknown) => unknown;

class DiffHighlightDirective extends AsyncDirective {
  private lines?: readonly DiffLine[];
  private path?: string;
  private oldPath?: string;
  private highlighted: ReadonlyMap<DiffLine, unknown> = new Map();
  private renderDiff?: RenderDiff;
  private readonly renderLine = (line: DiffLine) => this.highlighted.get(line) ?? line.text;

  override render(lines: readonly DiffLine[], file: DiffFilePaths, renderDiff: RenderDiff) {
    const { path, oldPath = path } = file;
    this.renderDiff = renderDiff;
    if (this.lines !== lines || this.path !== path || this.oldPath !== oldPath) {
      this.lines = lines;
      this.path = path;
      this.oldPath = oldPath;
      this.highlighted = new Map();
      void import("./chat-diff-highlight.runtime.ts")
        .then(({ highlightDiffLines }) => highlightDiffLines(lines, path, oldPath))
        .then((highlighted) => {
          // A refreshed patch can replace these rows while a language loads.
          if (this.lines !== lines || this.path !== path || this.oldPath !== oldPath) {
            return;
          }
          this.highlighted = highlighted;
          if (this.isConnected) {
            this.setValue(this.renderDiff?.(this.renderLine));
          }
        })
        .catch(() => {
          // A failed lazy chunk must leave the original escaped diff visible.
        });
    }
    return renderDiff(this.renderLine);
  }

  protected override reconnected() {
    this.setValue(this.renderDiff?.(this.renderLine));
  }
}

export const renderHighlightedDiff = directive(DiffHighlightDirective);

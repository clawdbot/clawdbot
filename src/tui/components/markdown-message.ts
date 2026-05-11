import { Container, Spacer } from "@earendil-works/pi-tui";
import { markdownTheme } from "../theme/theme.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";

type MarkdownOptions = ConstructorParameters<typeof HyperlinkMarkdown>[4];

export class MarkdownMessageComponent extends Container {
  private body: HyperlinkMarkdown;

  constructor(text: string, y: number, options?: MarkdownOptions) {
    super();
    this.body = new HyperlinkMarkdown(text, 0, y, markdownTheme, options);
    this.addChild(new Spacer(1));
    this.addChild(this.body);
  }

  setText(text: string) {
    this.body.setText(text);
  }
}

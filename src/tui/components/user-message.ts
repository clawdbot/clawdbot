// User message component renders user-authored chat entries in the TUI log.
import { theme } from "../theme/theme.js";
import { MarkdownMessageComponent } from "./markdown-message.js";

/** Markdown chat-log row styled as user input. */
export class UserMessageComponent extends MarkdownMessageComponent {
  constructor(text: string) {
    super(text, 1, {
      bgColor: (line) => theme.userBg(line),
      color: (line) => theme.userText(line),
    });
  }
}

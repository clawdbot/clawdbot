// BTW inline message component renders compact aside messages in chat.
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";

// Inline overlay message for BTW follow-up answers inside the chat log.
type BtwInlineMessageParams = {
  question: string;
  text: string;
  isError?: boolean;
};

/** Renders a dismissible BTW result, with error text or assistant markdown content. */
export class BtwInlineMessage extends Container {
  constructor(params: BtwInlineMessageParams) {
    super();
    this.setResult(params);
  }

  /** Replaces the current BTW content without reallocating the host component. */
  setResult(params: BtwInlineMessageParams) {
    this.clear();
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.header(`BTW: ${params.question}`), 1, 0));
    if (params.isError) {
      this.addChild(new Text(theme.error(params.text), 1, 0));
    } else {
      this.addChild(new AssistantMessageComponent(params.text));
    }
    this.addChild(new Text(theme.dim("Press Enter or Esc to dismiss"), 1, 0));
  }
}

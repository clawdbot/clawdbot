// Confirmation-body builder for the /models picker's final selection edit.
import { describe, expect, it } from "vitest";
import { buildModelSelectionConfirmation } from "./model-confirmation-message.js";
import { richTextToPlainString } from "./rich-block-model.js";

describe("buildModelSelectionConfirmation", () => {
  it("renders a non-default selection with an escaped HTML body and a matching rich block", () => {
    const confirmation = buildModelSelectionConfirmation({
      isDefaultSelection: false,
      provider: "openai",
      model: "gpt-5.4",
      runtimeReset: false,
    });

    expect(confirmation.html).toBe(
      "\u{2705} Model changed to <b>openai/gpt-5.4</b>\n\nSession-only model selection. Runtime unchanged. Use /model openai/gpt-5.4 --runtime &lt;runtime&gt; -s to switch harnesses. The agent default in openclaw.json is unchanged. This chat keeps the model selection across /new and /reset; use /model default -s to clear the session model selection.",
    );
    const plain = confirmation.richBlocks
      .map((block) => richTextToPlainString(block.text))
      .join("\n");
    expect(plain).toBe(
      "\u{2705} Model changed to openai/gpt-5.4\n\nSession-only model selection. Runtime unchanged. Use /model openai/gpt-5.4 --runtime <runtime> -s to switch harnesses. The agent default in openclaw.json is unchanged. This chat keeps the model selection across /new and /reset; use /model default -s to clear the session model selection.",
    );
  });

  it("escapes HTML-significant characters in provider/model ids only in the HTML body", () => {
    // Provider/model ids are plugin-supplied and not guaranteed HTML/markdown-safe;
    // the HTML body must escape them but the rich block must not (it isn't parsed
    // as markup, so escaping there would corrupt the literal id).
    const confirmation = buildModelSelectionConfirmation({
      isDefaultSelection: false,
      provider: "openai",
      model: "<script>&model",
      runtimeReset: false,
    });

    expect(confirmation.html).toContain("&lt;script&gt;&amp;model");
    const plain = confirmation.richBlocks
      .map((block) => richTextToPlainString(block.text))
      .join("\n");
    expect(plain).toContain("openai/<script>&model");
  });

  it("renders a default-selection reset with the auth-profile notice included", () => {
    const confirmation = buildModelSelectionConfirmation({
      isDefaultSelection: true,
      provider: "openai",
      model: "gpt-5.4",
      runtimeReset: true,
      defaultAuthProfileNotice: "Compatible auth profile retained.",
    });

    expect(confirmation.html).toBe(
      "\u{2705} Model reset to default\n\nSession model selection cleared. Compatible auth profile retained. Runtime reset to configured policy. New replies use the agent's configured default.",
    );
    const plain = confirmation.richBlocks
      .map((block) => richTextToPlainString(block.text))
      .join("\n");
    expect(plain).toBe(confirmation.html);
  });
});

/**
 * Builds the /models picker's final selection confirmation body in both
 * representations the callback funnel can send: legacy HTML text (used when
 * richMessages is disabled, or as a fallback) and hand-built rich blocks
 * (used when richMessages is enabled, since the picker's provider/model-list
 * edits already went through the rich funnel and this confirmation edits
 * that same rich-sent message — see the call site's #123886 note).
 */
import { boldRichText, paragraphBlock, type InputRichBlock } from "./rich-block-model.js";

const CHECK_MARK_EMOJI = "\u{2705}";

function escapeModelConfirmationHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type ModelSelectionConfirmationParams = {
  isDefaultSelection: boolean;
  provider: string;
  model: string;
  runtimeReset: boolean;
  defaultAuthProfileNotice?: string;
};

type ModelSelectionConfirmation = {
  html: string;
  richBlocks: InputRichBlock[];
};

export function buildModelSelectionConfirmation(
  params: ModelSelectionConfirmationParams,
): ModelSelectionConfirmation {
  const { isDefaultSelection, provider, model, runtimeReset, defaultAuthProfileNotice } = params;
  const runtimeText = runtimeReset ? "Runtime reset to configured policy." : "Runtime unchanged.";
  // Shared between the legacy-HTML and rich confirmation bodies so the two
  // renderings can't drift apart; only the model-id escaping and the runtime
  // placeholder spelling differ per funnel.
  const buildScopeText = (escapeModelId: (text: string) => string, runtimePlaceholder: string) =>
    isDefaultSelection
      ? `Session model selection cleared.${defaultAuthProfileNotice ? ` ${defaultAuthProfileNotice}` : ""} ${runtimeText} New replies use the agent's configured default.`
      : `Session-only model selection. ${runtimeText} Use /model ${escapeModelId(provider)}/${escapeModelId(model)} --runtime ${runtimePlaceholder} -s to switch harnesses. The agent default in openclaw.json is unchanged. This chat keeps the model selection across /new and /reset; use /model default -s to clear the session model selection.`;

  const scopeText = buildScopeText(escapeModelConfirmationHtml, "&lt;runtime&gt;");
  const actionText = isDefaultSelection
    ? "reset to default"
    : `changed to <b>${escapeModelConfirmationHtml(provider)}/${escapeModelConfirmationHtml(model)}</b>`;
  const html = `${CHECK_MARK_EMOJI} Model ${actionText}\n\n${scopeText}`;

  const richScopeText = buildScopeText((text) => text, "<runtime>");
  const richBlocks: InputRichBlock[] = [
    paragraphBlock(
      isDefaultSelection
        ? `${CHECK_MARK_EMOJI} Model reset to default\n\n${richScopeText}`
        : [
            `${CHECK_MARK_EMOJI} Model changed to `,
            boldRichText(`${provider}/${model}`),
            `\n\n${richScopeText}`,
          ],
    ),
  ];

  return { html, richBlocks };
}

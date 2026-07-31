/** Lists active ClawHub promotional model offers. */
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  ClawHubRequestError,
  fetchClawHubPromotions,
  type ClawHubPromotion,
} from "../../infra/clawhub.js";
import { markPromotionSlugsNotified } from "../../infra/promotions-feed.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

function formatWindowEnd(promotion: ClawHubPromotion): string {
  const daysLeft = Math.max(0, Math.ceil((promotion.endsAt - Date.now()) / 86_400_000));
  if (daysLeft === 0) {
    return "ends today";
  }
  return daysLeft === 1 ? "1 day left" : `${daysLeft} days left`;
}

export async function promosListCommand(opts: { json?: boolean }, runtime: RuntimeEnv) {
  let promotions: ClawHubPromotion[];
  try {
    promotions = await fetchClawHubPromotions();
  } catch (error) {
    if (!(error instanceof ClawHubRequestError) || error.status !== 404) {
      throw error;
    }
    if (opts.json) {
      writeRuntimeJson(runtime, { promotions: [] });
    } else {
      runtime.log("Promotions are not available from ClawHub yet.");
    }
    return;
  }
  // The user has now seen these offers; suppress the one-time passive
  // discovery notice for them (`models list` reads the same markers).
  markPromotionSlugsNotified(promotions.map((promotion) => promotion.slug));
  if (opts.json) {
    writeRuntimeJson(runtime, { promotions });
    return;
  }
  if (promotions.length === 0) {
    runtime.log("No active promotions right now.");
    return;
  }
  // Promotion text is remote content; strip control sequences before it can
  // reach an interactive terminal.
  const safe = sanitizeTerminalText;
  for (const promotion of promotions) {
    const sponsor = promotion.sponsor ? ` — ${safe(promotion.sponsor)}` : "";
    runtime.log(`${safe(promotion.title)}${sponsor} (${formatWindowEnd(promotion)})`);
    runtime.log(`  ${safe(promotion.blurb)}`);
    for (const model of promotion.models) {
      const alias = model.alias ? ` (${safe(model.alias)})` : "";
      const suggested = model.suggestedDefault ? " — suggested default" : "";
      runtime.log(`  · ${safe(model.modelRef)}${alias}${suggested}`);
    }
    runtime.log(`  Claim: ${formatCliCommand(`openclaw promos claim ${safe(promotion.slug)}`)}`);
  }
}

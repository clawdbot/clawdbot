import { Container } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeDiscordAccentColor, resolveDiscordAccentColor } from "./ui-colors.js";

export { normalizeDiscordAccentColor, resolveDiscordAccentColor } from "./ui-colors.js";

type DiscordContainerComponents = ConstructorParameters<typeof Container>[0];

export class DiscordUiContainer extends Container {
  constructor(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    components?: DiscordContainerComponents;
    accentColor?: string;
    spoiler?: boolean;
  }) {
    const accentOverride = normalizeDiscordAccentColor(params.accentColor);
    const accentColor =
      accentOverride ?? resolveDiscordAccentColor({ cfg: params.cfg, accountId: params.accountId });
    super(params.components, { accentColor, spoiler: params.spoiler });
  }
}

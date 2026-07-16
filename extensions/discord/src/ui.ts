import { Container } from "@buape/carbon";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { inspectDiscordAccount } from "./account-inspect.js";

const DEFAULT_DISCORD_ACCENT_COLOR = "#5865F2";

type DiscordContainerComponents = ConstructorParameters<typeof Container>[0];

type ResolveDiscordAccentColorParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
};

export function normalizeDiscordAccentColor(raw?: string | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(normalized)) {
    return null;
  }
  return normalized.toUpperCase();
}

export function resolveDiscordAccentColor(params: ResolveDiscordAccentColorParams): string {
  const account = inspectDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const configured = normalizeDiscordAccentColor(account.config.ui?.components?.accentColor);
  return configured ?? DEFAULT_DISCORD_ACCENT_COLOR;
}

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

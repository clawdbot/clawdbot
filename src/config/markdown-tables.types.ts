import type { MarkdownTableMode } from "./types.base.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export type ResolveMarkdownTableModeParams = {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
};

export type ResolveMarkdownTableMode = (
  params: ResolveMarkdownTableModeParams,
) => MarkdownTableMode;

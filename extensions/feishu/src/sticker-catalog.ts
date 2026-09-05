import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

type StickerMatch = { fileId: string; keyword: string };
type StickerSetEntries = Array<[fileKey: string, keywords: string[]]>;
const STICKER_QUERY_PATTERN = /^[^\p{Cs}]{1,128}$/u;

function fitsStickerSearchResult(stickers: StickerMatch[]): boolean {
  // 3 KiB fits a full 512-scalar key, a 64-scalar JSON-escaped keyword, and framing.
  // Reserve the longer boolean spelling so changing truncated cannot exceed the cap.
  return Buffer.byteLength(JSON.stringify({ stickers, truncated: false }), "utf8") <= 3072;
}

export function resolveFeishuStickerSet(
  cfg: ClawdbotConfig,
  account: ResolvedFeishuAccount,
): StickerSetEntries {
  // Bot identity owns received keys; merged account config must never supply a catalog.
  // SAFETY: Feishu's channel schema validates this plugin-owned config before use.
  const sets = (cfg.channels?.feishu as FeishuConfig | undefined)?.stickerSets;
  const set =
    sets && account.appId && Object.hasOwn(sets, account.appId) ? sets[account.appId] : undefined;
  return set ? Object.entries(set) : [];
}

export function searchFeishuStickerSet(
  entries: StickerSetEntries,
  params: Record<string, unknown>,
): { stickers: StickerMatch[]; truncated: boolean } {
  const query = readStringParam(params, "query", { required: true });
  if (!STICKER_QUERY_PATTERN.test(query)) {
    throw new Error("Feishu sticker-search query must contain 1–128 Unicode characters.");
  }
  const limit = params.limit === undefined ? 5 : params.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Feishu sticker-search limit must be an integer from 1 through 10.");
  }
  const needle = query.toLowerCase();
  const stickers: StickerMatch[] = [];
  for (const [fileId, keywords] of entries) {
    const keyword = keywords.find((label) => label.toLowerCase().includes(needle));
    if (keyword === undefined) {
      continue;
    }
    const match = { fileId, keyword };
    if (stickers.length === limit || !fitsStickerSearchResult([...stickers, match])) {
      return { stickers, truncated: true };
    }
    stickers.push(match);
  }
  return { stickers, truncated: false };
}

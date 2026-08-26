import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import { z } from "zod";
import type { ClawdbotConfig } from "../runtime-api.js";
import { FEISHU_EXTERNAL_KEY_PATTERN } from "./external-keys.js";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

type StickerMatch = { fileId: string; keyword: string };
type StickerSetEntries = Array<[fileKey: string, keywords: string[]]>;
const MAX_STICKER_SETS = 32;
const MAX_STICKERS_PER_SET = 256;

function canonicalTextPattern(maxLength: number): RegExp {
  // Quantifiers enforce the same scalar bound in Zod and exported JSON Schema;
  // maxLength alone differs between their UTF-16 and grapheme counting rules.
  return new RegExp(`^(?!\\s)(?![\\s\\S]*\\s$)[^\\p{Cs}]{1,${maxLength}}$`, "u");
}
const STICKER_QUERY_PATTERN = canonicalTextPattern(128);

function fitsStickerSearchResult(stickers: StickerMatch[]): boolean {
  // 3 KiB fits a full 512-scalar key, a 64-scalar JSON-escaped keyword, and framing.
  // Reserve the longer boolean spelling so changing truncated cannot exceed the cap.
  return Buffer.byteLength(JSON.stringify({ stickers, truncated: false }), "utf8") <= 3072;
}

const FeishuStickerSetSchema = z
  .record(
    z.string().regex(FEISHU_EXTERNAL_KEY_PATTERN),
    z
      .array(z.string().regex(canonicalTextPattern(64)))
      .min(1)
      .max(8),
  )
  .refine((set) => Object.keys(set).length <= MAX_STICKERS_PER_SET, {
    message: `At most ${MAX_STICKERS_PER_SET} stickers per bot set are allowed`,
  })
  .meta({ maxProperties: MAX_STICKERS_PER_SET });

export const FeishuStickerSetsSchema = z
  .record(z.string().regex(canonicalTextPattern(128)), FeishuStickerSetSchema)
  .refine((sets) => Object.keys(sets).length <= MAX_STICKER_SETS, {
    message: `At most ${MAX_STICKER_SETS} bot sticker sets are allowed`,
  })
  .meta({ maxProperties: MAX_STICKER_SETS });

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

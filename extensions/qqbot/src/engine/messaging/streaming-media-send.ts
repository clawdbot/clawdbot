/**
 * 富媒体标签解析与发送队列
 *
 * 提供媒体标签（qqimg / qqvoice / qqvideo / qqfile / qqmedia）的检测、
 * 拆分、路径编码修复，以及统一的发送队列执行器。
 */

import type { GatewayAccount } from "../types.js";
import { normalizeMediaTags } from "../utils/media-tags.js";
import { normalizePath } from "../utils/platform.js";
import {
  sendPhoto,
  sendVoice,
  sendVideoMsg,
  sendDocument,
  sendMedia as sendMediaAuto,
  DEFAULT_MEDIA_SEND_ERROR,
  resolveUserFacingMediaError,
  type MediaTargetContext,
} from "./outbound.js";

function formatStreamSendErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ============ 类型定义 ============

/** 发送队列项 */
export interface SendQueueItem {
  type: "text" | "image" | "voice" | "video" | "file" | "media";
  content: string;
}

/** 统一的媒体标签正则 — 匹配标准化后的 6 种标签 */
export const MEDIA_TAG_REGEX =
  /<(qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|qqmedia|img)>/gi;

/** 创建一个新的全局标签正则实例（每次调用 reset lastIndex） */
export function createMediaTagRegex(): RegExp {
  return new RegExp(MEDIA_TAG_REGEX.source, MEDIA_TAG_REGEX.flags);
}

/** 媒体发送上下文（统一的，供流式和普通模式共用） */
export interface MediaSendContext {
  /** 媒体目标上下文（用于 sendPhoto/sendVoice 等） */
  mediaTarget: MediaTargetContext;
  /** qualifiedTarget（格式 "qqbot:c2c:xxx" 或 "qqbot:group:xxx"，用于 sendMediaAuto） */
  qualifiedTarget: string;
  /** 账户配置 */
  account: GatewayAccount;
  /** 事件消息 ID（用于被动回复） */
  replyToId?: string;
  /** 日志 */
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

// ============ 路径编码修复 ============

/**
 * 修复路径编码问题（双反斜杠、八进制转义、UTF-8 双重编码）
 *
 * 这是由于 LLM 输出路径时可能引入的编码问题：
 * - Markdown 转义导致双反斜杠
 * - 八进制转义序列（来自某些 shell 工具的输出）
 * - UTF-8 双重编码（中文路径经过多层处理后的乱码）
 *
 * 此方法在 gateway.ts deliver 回调、outbound.ts sendText、
 * streaming.ts sendMediaQueue 中共用。
 */
export function fixPathEncoding(
  mediaPath: string,
  log?: { debug?: (msg: string) => void; error?: (msg: string) => void },
): string {
  // 1. 双反斜杠 -> 单反斜杠（Markdown 转义）
  let result = mediaPath.replace(/\\\\/g, "\\");

  // Skip octal escape decoding for Windows local paths (e.g. C:\Users\1\file.txt)
  // where backslash-digit sequences like \1, \2 ... \7 are directory separators,
  // not octal escape sequences.
  const isWinLocal = /^[a-zA-Z]:[\\/]/.test(mediaPath) || mediaPath.startsWith("\\\\");
  // 2. 八进制转义序列 + UTF-8 双重编码修复
  try {
    const hasOctal = /\\[0-7]{1,3}/.test(result);
    const hasNonASCII = /[\u0080-\u00FF]/.test(result);

    if (!isWinLocal && (hasOctal || hasNonASCII)) {
      log?.debug?.(`Decoding path with mixed encoding: ${result}`);

      // Step 1: 将八进制转义转换为字节
      let decoded = result.replace(/\\([0-7]{1,3})/g, (_: string, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      );

      // Step 2: 提取所有字节（包括 Latin-1 字符）
      const bytes: number[] = [];
      for (let i = 0; i < decoded.length; i++) {
        const code = decoded.charCodeAt(i);
        if (code <= 0xff) {
          bytes.push(code);
        } else {
          const charBytes = Buffer.from(decoded[i], "utf8");
          bytes.push(...charBytes);
        }
      }

      // Step 3: 尝试按 UTF-8 解码
      const buffer = Buffer.from(bytes);
      const utf8Decoded = buffer.toString("utf8");

      if (!utf8Decoded.includes("\uFFFD") || utf8Decoded.length < decoded.length) {
        result = utf8Decoded;
        log?.debug?.(`Successfully decoded path: ${result}`);
      }
    }
  } catch (decodeErr) {
    log?.error?.(`Path decode error: ${formatStreamSendErr(decodeErr)}`);
  }

  return result;
}

// ============ 代码块检测 ============

/**
 * 判断文本中给定位置是否处于围栏代码块内（``` 块）。
 *
 * 围栏代码块：行首 ``` 开始，到下一个行首 ``` 结束（或文本末尾）
 *
 * @param text 完整文本
 * @param position 要检测的位置（字符索引）
 * @returns 如果 position 在围栏代码块内返回 true
 */
export function isInsideCodeBlock(text: string, position: number): boolean {
  const fenceRegex = /^(`{3,})[^\n]*$/gm;
  let fenceMatch: RegExpExecArray | null;
  let openFence: { pos: number; ticks: number } | null = null;

  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const ticks = fenceMatch[1].length;
    if (!openFence) {
      openFence = { pos: fenceMatch.index, ticks };
    } else if (ticks >= openFence.ticks) {
      // 闭合围栏
      if (position >= openFence.pos && position < fenceMatch.index + fenceMatch[0].length) {
        return true;
      }
      openFence = null;
    }
  }
  // 未闭合的围栏一直延伸到文本末尾
  if (openFence && position >= openFence.pos) {
    return true;
  }

  return false;
}

// ============ 媒体标签解析 ============

/**
 * 检测文本是否包含富媒体标签（忽略代码块内的标签）
 */
export function hasMediaTags(text: string): boolean {
  const normalized = normalizeMediaTags(text);
  const regex = createMediaTagRegex();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalized)) !== null) {
    if (!isInsideCodeBlock(normalized, match.index)) {
      return true;
    }
  }
  return false;
}

/** findFirstClosedMediaTag 的返回值 */
export interface FirstClosedMediaTag {
  /** 标签前的纯文本 */
  textBefore: string;
  /** 标签类型（小写，如 "qqvoice"） */
  tagName: string;
  /** 标签内的媒体路径（已 trim、去 MEDIA: 前缀、修复编码） */
  mediaPath: string;
  /** 标签在输入文本中的结束索引（紧接标签后的第一个字符位置） */
  tagEndIndex: number;
  /** 映射后的发送队列项类型 */
  itemType: SendQueueItem["type"];
}

/**
 * 在文本中查找**第一个**完整闭合的媒体标签
 *
 * 与 splitByMediaTags 不同，此函数只匹配一个标签就停止，
 * 用于流式场景的"循环消费"模式：每次处理一个标签，更新偏移，再找下一个。
 *
 * @param text 待检查的文本（应已 normalize 过）
 * @returns 第一个闭合标签的信息，没有则返回 null
 */
export function findFirstClosedMediaTag(
  text: string,
  log?: {
    info?: (msg: string) => void;
    debug?: (msg: string) => void;
    error?: (msg: string) => void;
  },
): FirstClosedMediaTag | null {
  const regex = createMediaTagRegex();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // 跳过代码块内的媒体标签
    if (isInsideCodeBlock(text, match.index)) {
      log?.debug?.(
        `findFirstClosedMediaTag: skipping <${match[1]}> at index ${match.index} (inside code block)`,
      );
      continue;
    }

    const textBefore = text.slice(0, match.index);
    const tagName = match[1].toLowerCase();
    let mediaPath = match[2]?.trim() ?? "";

    // 剥离 MEDIA: 前缀
    if (mediaPath.startsWith("MEDIA:")) {
      mediaPath = mediaPath.slice("MEDIA:".length);
    }
    mediaPath = normalizePath(mediaPath);
    mediaPath = fixPathEncoding(mediaPath, log);

    const typeMap: Record<string, SendQueueItem["type"]> = {
      qqimg: "image",
      qqvoice: "voice",
      qqvideo: "video",
      qqfile: "file",
      qqmedia: "media",
    };

    return {
      textBefore,
      tagName,
      mediaPath,
      tagEndIndex: match.index + match[0].length,
      itemType: typeMap[tagName] ?? "image",
    };
  }

  return null;
}

/**
 * 媒体标签拆分结果
 */
export interface MediaSplitResult {
  /** 是否包含媒体标签 */
  hasMediaTags: boolean;
  /** 媒体标签前的纯文本 */
  textBeforeFirstTag: string;
  /** 媒体标签后的剩余文本 */
  textAfterLastTag: string;
  /** 完整的发送队列（标签间的文本 + 媒体项） */
  mediaQueue: SendQueueItem[];
}

/**
 * 将文本按富媒体标签拆分为三部分
 *
 * 用于两个场景：
 * 1. 流式模式：中断-恢复流程（标签前文本 → 结束流式 → 发送媒体 → 新流式 → 标签后文本）
 * 2. 普通模式：构建按顺序发送的队列
 */
export function splitByMediaTags(
  text: string,
  log?: {
    info?: (msg: string) => void;
    debug?: (msg: string) => void;
    error?: (msg: string) => void;
  },
): MediaSplitResult {
  const normalized = normalizeMediaTags(text);
  const regex = createMediaTagRegex();
  // 过滤掉代码块内的匹配
  const matches = [...normalized.matchAll(regex)].filter(
    (m) => !isInsideCodeBlock(normalized, m.index),
  );

  if (matches.length === 0) {
    return {
      hasMediaTags: false,
      textBeforeFirstTag: normalized,
      textAfterLastTag: "",
      mediaQueue: [],
    };
  }

  // 第一个标签前的纯文本
  const firstMatch = matches[0];
  const textBeforeFirstTag = normalized
    .slice(0, firstMatch.index)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 最后一个标签后的纯文本
  const lastMatch = matches[matches.length - 1];
  const lastMatchEnd = lastMatch.index + lastMatch[0].length;
  const textAfterLastTag = normalized
    .slice(lastMatchEnd)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 构建媒体发送队列
  const mediaQueue: SendQueueItem[] = [];
  let lastIndex = firstMatch.index;

  for (const match of matches) {
    // 标签前的文本（标签之间的间隔文本）
    const textBetween = normalized
      .slice(lastIndex, match.index)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (textBetween && lastIndex !== firstMatch.index) {
      // 只添加非首段的间隔文本（首段由 textBeforeFirstTag 覆盖）
      mediaQueue.push({ type: "text", content: textBetween });
    }

    // 解析标签内容
    const tagName = match[1].toLowerCase();
    let mediaPath = match[2]?.trim() ?? "";

    // 剥离 MEDIA: 前缀
    if (mediaPath.startsWith("MEDIA:")) {
      mediaPath = mediaPath.slice("MEDIA:".length);
    }
    mediaPath = normalizePath(mediaPath);

    // 修复路径编码问题
    mediaPath = fixPathEncoding(mediaPath, log);

    // 根据标签类型加入队列
    const typeMap: Record<string, SendQueueItem["type"]> = {
      qqimg: "image",
      qqvoice: "voice",
      qqvideo: "video",
      qqfile: "file",
      qqmedia: "media",
    };
    const itemType = typeMap[tagName] ?? "image";
    if (mediaPath) {
      mediaQueue.push({ type: itemType, content: mediaPath });
      log?.info?.(`Found ${itemType} in <${tagName}>: ${mediaPath.slice(0, 80)}`);
    }

    lastIndex = match.index + match[0].length;
  }

  return {
    hasMediaTags: true,
    textBeforeFirstTag,
    textAfterLastTag,
    mediaQueue,
  };
}

/**
 * 从文本中解析出完整的发送队列（含标签前后的纯文本）
 *
 * 与 splitByMediaTags 的区别：
 * - splitByMediaTags 分为 before / queue / after 三段（供流式模式的中断-恢复）
 * - parseMediaTagsToSendQueue 返回一个扁平的完整队列（供普通模式按顺序发送）
 *
 * 适用于 gateway.ts deliver 回调和 outbound.ts sendText。
 */
export function parseMediaTagsToSendQueue(
  text: string,
  log?: {
    info?: (msg: string) => void;
    debug?: (msg: string) => void;
    error?: (msg: string) => void;
  },
): { hasMediaTags: boolean; sendQueue: SendQueueItem[] } {
  const split = splitByMediaTags(text, log);

  if (!split.hasMediaTags) {
    return { hasMediaTags: false, sendQueue: [] };
  }

  const sendQueue: SendQueueItem[] = [];

  // 标签前的文本
  if (split.textBeforeFirstTag) {
    sendQueue.push({ type: "text", content: split.textBeforeFirstTag });
  }

  // 媒体队列（含标签间文本）
  sendQueue.push(...split.mediaQueue);

  // 标签后的文本
  if (split.textAfterLastTag) {
    sendQueue.push({ type: "text", content: split.textAfterLastTag });
  }

  return { hasMediaTags: true, sendQueue };
}

// ============ 发送队列执行 ============

/**
 * 统一执行发送队列
 *
 * 遍历 sendQueue，按类型调用对应的发送函数。
 * 文本项通过 onSendText 回调处理（不同场景的文本发送方式不同）。
 * 媒体发送失败时，通过 onSendText 发送兜底文本通知用户。
 */
export async function executeSendQueue(
  queue: SendQueueItem[],
  ctx: MediaSendContext,
  options: {
    /** 文本发送回调（每种场景的文本发送方式不同） */
    onSendText?: (text: string) => Promise<void>;
    /** 是否跳过 inter-tag 文本（流式模式下通常跳过，由新流式会话处理） */
    skipInterTagText?: boolean;
  } = {},
): Promise<void> {
  const { mediaTarget, qualifiedTarget, account, replyToId, log } = ctx;
  const prefix = mediaTarget.logPrefix ?? `[qqbot:${account.accountId}]`;

  /** 媒体发送失败时的兜底：通过 onSendText 发送错误文本给用户 */
  const sendFallbackText = async (errorMsg: string): Promise<void> => {
    if (!options.onSendText) {
      log?.info(`${prefix} executeSendQueue: no onSendText handler, cannot send fallback text`);
      return;
    }
    try {
      await options.onSendText(errorMsg);
    } catch (fallbackErr) {
      log?.error(
        `${prefix} executeSendQueue: fallback text send failed: ${formatStreamSendErr(fallbackErr)}`,
      );
    }
  };

  for (const item of queue) {
    try {
      if (item.type === "text") {
        if (options.skipInterTagText) {
          log?.info(
            `${prefix} executeSendQueue: skipping inter-tag text (${item.content.length} chars)`,
          );
          continue;
        }
        if (options.onSendText) {
          await options.onSendText(item.content);
        } else {
          log?.info(`${prefix} executeSendQueue: no onSendText handler, skipping text`);
        }
        continue;
      }

      log?.info(
        `${prefix} executeSendQueue: sending ${item.type}: ${item.content.slice(0, 80)}...`,
      );

      if (item.type === "image") {
        const result = await sendPhoto(mediaTarget, item.content);
        if (result.error) {
          log?.error(`${prefix} sendPhoto error: ${result.error}`);
          await sendFallbackText(resolveUserFacingMediaError(result));
        }
      } else if (item.type === "voice") {
        const uploadFormats =
          account.config?.audioFormatPolicy?.uploadDirectFormats ??
          account.config?.voiceDirectUploadFormats;
        const transcodeEnabled = account.config?.audioFormatPolicy?.transcodeEnabled !== false;
        const voiceTimeout = 45000; // 45s
        try {
          const result = await Promise.race([
            sendVoice(mediaTarget, item.content, uploadFormats, transcodeEnabled),
            new Promise<{ channel: string; error: string }>((resolve) =>
              setTimeout(
                () => resolve({ channel: "qqbot", error: "语音发送超时，已跳过" }),
                voiceTimeout,
              ),
            ),
          ]);
          if (result.error) {
            log?.error(`${prefix} sendVoice error: ${result.error}`);
            await sendFallbackText(resolveUserFacingMediaError(result));
          }
        } catch (err) {
          log?.error(`${prefix} sendVoice unexpected error: ${formatStreamSendErr(err)}`);
          await sendFallbackText(DEFAULT_MEDIA_SEND_ERROR);
        }
      } else if (item.type === "video") {
        const result = await sendVideoMsg(mediaTarget, item.content);
        if (result.error) {
          log?.error(`${prefix} sendVideoMsg error: ${result.error}`);
          await sendFallbackText(resolveUserFacingMediaError(result));
        }
      } else if (item.type === "file") {
        const result = await sendDocument(mediaTarget, item.content);
        if (result.error) {
          log?.error(`${prefix} sendDocument error: ${result.error}`);
          await sendFallbackText(resolveUserFacingMediaError(result));
        }
      } else if (item.type === "media") {
        const result = await sendMediaAuto({
          to: qualifiedTarget,
          text: "",
          mediaUrl: item.content,
          accountId: account.accountId,
          replyToId,
          account,
        });
        if (result.error) {
          log?.error(`${prefix} sendMedia(auto) error: ${result.error}`);
          await sendFallbackText(resolveUserFacingMediaError(result));
        }
      }
    } catch (err) {
      log?.error(
        `${prefix} executeSendQueue: failed to send ${item.type}: ${formatStreamSendErr(err)}`,
      );
      await sendFallbackText(DEFAULT_MEDIA_SEND_ERROR);
    }
  }
}

/**
 * 从文本中剥离所有媒体标签（用于最终显示）
 */
export function stripMediaTags(text: string): string {
  const regex = createMediaTagRegex();
  return text
    .replace(regex, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 检测文本中是否有未闭合的媒体标签，如果有则截断到安全位置。
 *
 * 流式输出中 LLM 逐 token 吐出媒体标签，中间态不应直接发给用户。
 * 只检查最后一行，从右到左扫描 `<`，找到第一个有意义的媒体标签片段并判断是否完整。
 *
 * 核心原则：截断只能截到**开标签**前面；闭合标签前缀若找不到对应开标签则原样返回。
 */
export function stripIncompleteMediaTag(text: string): [safeText: string, hasIncomplete: boolean] {
  if (!text) {
    return [text, false];
  }

  const lastNL = text.lastIndexOf("\n");
  const lastLine = lastNL === -1 ? text : text.slice(lastNL + 1);
  if (!lastLine) {
    return [text, false];
  } // 以换行结尾，安全

  const lineStart = lastNL === -1 ? 0 : lastNL + 1;

  // ---- 媒体标签名判断 ----
  const MEDIA_NAMES = [
    "qq",
    "img",
    "image",
    "pic",
    "photo",
    "voice",
    "audio",
    "video",
    "file",
    "doc",
    "media",
    "attach",
    "send",
    "document",
    "picture",
    "qqvoice",
    "qqaudio",
    "qqvideo",
    "qqimg",
    "qqimage",
    "qqfile",
    "qqpic",
    "qqphoto",
    "qqmedia",
    "qqattach",
    "qqsend",
    "qqdocument",
    "qqpicture",
  ];
  const isMedia = (n: string) => MEDIA_NAMES.includes(n.toLowerCase());
  const couldBeMedia = (n: string) => {
    const l = n.toLowerCase();
    return MEDIA_NAMES.some((m) => m.startsWith(l));
  };

  /** 截断到 lastLine 中位置 pos 之前，返回 [safe, true] */
  const cutAt = (pos: number): [string, true] => [text.slice(0, lineStart + pos).trimEnd(), true];

  /** 检查 lastLine 中位置 pos 处的媒体开标签后面是否有完整闭合标签 */
  const hasClosingAfter = (pos: number, name: string): boolean => {
    const rest = lastLine.slice(pos + 1); // < 之后
    const gt = rest.search(/[>＞]/);
    if (gt < 0) {
      return false;
    }
    const after = rest.slice(gt + 1);
    return new RegExp(`[<\uFF1C]/${name}\\s*[>\uFF1E]`, "i").test(after);
  };

  // ---- 回溯状态 ----
  // 遇到不完整的闭合标签/孤立 < 时，记录并继续往左找对应的开标签
  let searchTag: string | null = null; // 要找的开标签名，"*" = 来自孤立 <
  let searchIsClosing = false; // 触发回溯的是闭合类（</、</tag）还是开类（<）
  let fallbackPos = -1; // 最右边触发回溯的 < 的位置

  for (let i = lastLine.length - 1; i >= 0; i--) {
    const ch = lastLine[i];
    if (ch !== "<" && ch !== "\uFF1C") {
      continue;
    }

    const after = lastLine.slice(i + 1);
    const isClosing = after.startsWith("/");
    const nameStr = isClosing ? after.slice(1) : after;
    const nameMatch = nameStr.match(/^(\w+)/);

    // ======== 回溯模式：正在找对应的开标签 ========
    if (searchTag) {
      if (!nameMatch || isClosing) {
        continue;
      }
      const cand = nameMatch[1].toLowerCase();
      if (!isMedia(cand)) {
        continue;
      }
      // 跳过已有完整闭合对的开标签
      if (hasClosingAfter(i, cand)) {
        continue;
      }

      if (searchTag === "*") {
        return cutAt(i); // 通配：任何未闭合的媒体开标签都匹配
      }
      // 精确/前缀匹配（闭合标签名可能不完整，如 </qq 对 <qqvoice）
      const t = searchTag.toLowerCase();
      if (cand === t || cand.startsWith(t)) {
        return cutAt(i);
      }
      continue;
    }

    // ======== 正常扫描 ========

    // --- 无标签名：孤立 < 或 </ ---
    if (!nameMatch) {
      if (!after) {
        // 孤立 <：可能是新开标签，往左找未闭合的媒体开标签
        if (fallbackPos < 0) {
          fallbackPos = i;
        }
        searchTag = "*";
        searchIsClosing = false;
      } else if (after === "/") {
        // 孤立 </：闭合标签开始，找不到开标签时原样返回
        if (fallbackPos < 0) {
          fallbackPos = i;
        }
        searchTag = "*";
        searchIsClosing = true;
      }
      // 其他（如 "< 3"）：非标签，跳过
      continue;
    }

    const tag = nameMatch[1];
    const restAfterName = nameStr.slice(tag.length);
    const hasGT = /[>＞]/.test(restAfterName);

    // --- 不是媒体标签（也不是前缀） ---
    if (!isMedia(tag) && !(couldBeMedia(tag) && !hasGT)) {
      continue;
    }

    // --- 标签未闭合（无 >），还在输入中 ---
    if (!hasGT) {
      if (isClosing) {
        // 不完整闭合标签（如 </voice、</i）→ 回溯找开标签
        if (fallbackPos < 0) {
          fallbackPos = i;
        }
        searchTag = tag;
        searchIsClosing = true;
        continue;
      }
      // 不完整开标签（如 <img、<i）→ 截断
      return cutAt(i);
    }

    // --- 标签有 >，是完整的 ---
    if (isClosing) {
      return [text, false];
    } // 完整闭合标签 </tag> → 安全

    // 完整开标签 <tag...>，检查后面有无对应 </tag>
    if (hasClosingAfter(i, tag)) {
      return [text, false];
    }
    return cutAt(i); // 无闭合 → 截断
  }

  // ---- 循环结束，处理回溯未命中 ----
  if (searchTag) {
    if (!searchIsClosing) {
      // 来自孤立 <，前面没有媒体开标签 → 截断到那个 < 前面
      return cutAt(fallbackPos);
    }
    // 来自闭合类（</、</tag），前面找不到对应开标签 → 不可能是有效媒体标签，原样返回
    return [text, true];
  }

  return [text, false]; // 最后一行无任何 < → 安全
}

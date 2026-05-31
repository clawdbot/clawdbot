// Browser screenshot descriptions piggyback on the existing media image
// understanding contract. No browser-specific model registry lives here.

import { readFile } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { describeImageFile as DescribeImageFileFn } from "openclaw/plugin-sdk/media-understanding-runtime";
import type { saveMediaBuffer as SaveMediaBufferFn } from "../sdk-setup-tools.js";
import type { normalizeBrowserScreenshot as NormalizeBrowserScreenshotFn } from "./screenshot.js";

export const DEFAULT_BROWSER_SCREENSHOT_DESCRIPTION_PROMPT =
  "Describe what is visible in this browser screenshot. Capture page layout, headings, primary content blocks, visible text, and notable interactive elements so a text-only assistant can reason about the page.";

export type BrowserScreenshotDescriptionContext = {
  cfg: OpenClawConfig;
  filePath: string;
  agentDir?: string;
  workspaceDir?: string;
  agentId?: string;
  activeModel?: {
    provider?: string;
    model?: string;
  };
  mediaScope?: {
    sessionKey?: string;
    channel?: string;
    chatType?: string;
  };
  imageSanitization?: {
    maxDimensionPx?: number;
  };
};

export type BrowserScreenshotDescriptionDeps = {
  describeImageFile: typeof DescribeImageFileFn;
  normalizeBrowserScreenshot: typeof NormalizeBrowserScreenshotFn;
  saveMediaBuffer: typeof SaveMediaBufferFn;
};

export type BrowserScreenshotDescriptionResult = {
  text: string;
  provider?: string;
  model?: string;
  decision?: unknown;
};

function normalizeActiveModel(
  activeModel: BrowserScreenshotDescriptionContext["activeModel"],
): { provider: string; model?: string } | undefined {
  const provider = activeModel?.provider?.trim();
  if (!provider) {
    return undefined;
  }
  const model = activeModel?.model?.trim();
  return model ? { provider, model } : { provider };
}

async function resolveImageUnderstandingFilePath(
  ctx: BrowserScreenshotDescriptionContext,
  deps: BrowserScreenshotDescriptionDeps,
): Promise<string> {
  const maxDimensionPx = ctx.imageSanitization?.maxDimensionPx;
  if (typeof maxDimensionPx !== "number" || !Number.isFinite(maxDimensionPx)) {
    return ctx.filePath;
  }

  const source = await readFile(ctx.filePath);
  const normalized = await deps.normalizeBrowserScreenshot(source, {
    maxSide: Math.max(1, Math.floor(maxDimensionPx)),
  });
  if (normalized.buffer === source) {
    return ctx.filePath;
  }
  const saved = await deps.saveMediaBuffer(
    normalized.buffer,
    normalized.contentType ?? "image/jpeg",
    "browser",
  );
  return saved.path;
}

export async function describeBrowserScreenshot(
  ctx: BrowserScreenshotDescriptionContext,
  deps: BrowserScreenshotDescriptionDeps,
): Promise<BrowserScreenshotDescriptionResult | null> {
  const filePath = await resolveImageUnderstandingFilePath(ctx, deps);
  const described = await deps.describeImageFile({
    filePath,
    cfg: ctx.cfg,
    prompt: DEFAULT_BROWSER_SCREENSHOT_DESCRIPTION_PROMPT,
    agentDir: ctx.agentDir,
    workspaceDir: ctx.workspaceDir,
    activeModel: normalizeActiveModel(ctx.activeModel),
    scopeContext: ctx.mediaScope,
  });
  const text = described.text?.trim();
  if (!text) {
    return null;
  }
  return {
    text,
    provider: described.provider,
    model: described.model,
    decision: described.decision,
  };
}

export function neutralizeMediaDirectives(text: string): string {
  if (!text || !/media:/i.test(text)) {
    return text;
  }
  const lines = text.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const leading = line.length - line.trimStart().length;
    const rest = line.slice(leading);
    if (/^MEDIA:/i.test(rest)) {
      lines[i] = `${line.slice(0, leading)}[neutralized] ${rest}`;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : text;
}

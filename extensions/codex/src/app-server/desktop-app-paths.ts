/** Shared path candidates for Codex's macOS desktop app bundle. */
import { existsSync } from "node:fs";

export type MacOSDesktopCodexAppPathCandidate = {
  appName: "ChatGPT.app" | "Codex.app";
  appBundlePath: string;
  appServerCommandPath: string;
  bundledMarketplacePath: string;
};

export const MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES: readonly MacOSDesktopCodexAppPathCandidate[] =
  [
    {
      appName: "ChatGPT.app",
      appBundlePath: "/Applications/ChatGPT.app",
      appServerCommandPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      bundledMarketplacePath: "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled",
    },
    {
      appName: "Codex.app",
      appBundlePath: "/Applications/Codex.app",
      appServerCommandPath: "/Applications/Codex.app/Contents/Resources/codex",
      bundledMarketplacePath: "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled",
    },
  ] as const;

export function resolveMacOSDesktopCodexAppServerCommandCandidates(
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === "darwin"
    ? MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES.map((candidate) => candidate.appServerCommandPath)
    : [];
}

export function resolveMacOSDesktopCodexBundledMarketplaceCandidates(
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === "darwin"
    ? MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES.map((candidate) => candidate.bundledMarketplacePath)
    : [];
}

export function resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath(
  params: {
    platform?: NodeJS.Platform;
    candidates?: readonly string[];
    pathExists?: (filePath: string) => boolean;
  } = {},
): string | undefined {
  const candidates =
    params.candidates ?? resolveMacOSDesktopCodexBundledMarketplaceCandidates(params.platform);
  const pathExists = params.pathExists ?? existsSync;
  return candidates.find((candidate) => pathExists(candidate));
}

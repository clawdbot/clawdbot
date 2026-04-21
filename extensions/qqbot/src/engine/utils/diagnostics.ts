/**
 * Gateway startup diagnostics — extracted from utils/platform.ts.
 *
 * Depends on utils/platform.ts for detection functions, but no plugin-sdk.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { debugLog } from "./log.js";
import {
  getHomeDir,
  getTempDir,
  getQQBotDataDir,
  getPlatform,
  isWindows,
  detectFfmpeg,
  checkSilkWasmAvailable,
} from "./platform.js";

export interface DiagnosticReport {
  platform: string;
  arch: string;
  nodeVersion: string;
  homeDir: string;
  tempDir: string;
  dataDir: string;
  ffmpeg: string | null;
  silkWasm: boolean;
  warnings: string[];
}

/**
 * Run startup diagnostics and return an environment report.
 * Called during gateway startup to log environment details and warnings.
 */
export async function runDiagnostics(): Promise<DiagnosticReport> {
  const warnings: string[] = [];

  const platform = `${process.platform} (${os.release()})`;
  const arch = process.arch;
  const nodeVersion = process.version;
  const homeDir = getHomeDir();
  const tempDir = getTempDir();
  const dataDir = getQQBotDataDir();

  const ffmpegPath = await detectFfmpeg();
  if (!ffmpegPath) {
    warnings.push(
      isWindows()
        ? "⚠️ ffmpeg is not installed. Audio/video conversion will be limited. Install it with choco install ffmpeg, scoop install ffmpeg, or from https://ffmpeg.org."
        : getPlatform() === "darwin"
          ? "⚠️ ffmpeg is not installed. Audio/video conversion will be limited. Install it with brew install ffmpeg."
          : "⚠️ ffmpeg is not installed. Audio/video conversion will be limited. Install it with sudo apt install ffmpeg or sudo yum install ffmpeg.",
    );
  }

  const silkWasm = await checkSilkWasmAvailable();
  if (!silkWasm) {
    warnings.push(
      "⚠️ silk-wasm is unavailable. QQ voice send/receive will not work. Ensure Node.js >= 16 and WASM support are available.",
    );
  }

  try {
    const testFile = path.join(dataDir, ".write-test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  } catch {
    warnings.push(`⚠️ Data directory is not writable: ${dataDir}. Check filesystem permissions.`);
  }

  if (isWindows()) {
    if (/[\u4e00-\u9fa5]/.test(homeDir) || homeDir.includes(" ")) {
      warnings.push(
        `⚠️ Home directory contains Chinese characters or spaces: ${homeDir}. Some tools may fail. Consider setting QQBOT_DATA_DIR to an ASCII-only path.`,
      );
    }
  }

  const report: DiagnosticReport = {
    platform,
    arch,
    nodeVersion,
    homeDir,
    tempDir,
    dataDir,
    ffmpeg: ffmpegPath,
    silkWasm,
    warnings,
  };

  debugLog("=== QQBot Environment Diagnostics ===");
  debugLog(`  Platform: ${platform} (${arch})`);
  debugLog(`  Node: ${nodeVersion}`);
  debugLog(`  Home: ${homeDir}`);
  debugLog(`  Data dir: ${dataDir}`);
  debugLog(`  ffmpeg: ${ffmpegPath ?? "not installed"}`);
  debugLog(`  silk-wasm: ${silkWasm ? "available" : "unavailable"}`);
  if (warnings.length > 0) {
    debugLog("  --- Warnings ---");
    for (const w of warnings) {
      debugLog(`  ${w}`);
    }
  }
  debugLog("======================");

  return report;
}

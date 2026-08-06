/**
 * Gateway startup diagnostics — extracted from utils/platform.ts.
 *
 * Depends on utils/platform.ts for detection functions, but no plugin-sdk.
 */

import * as os from "node:os";
import { debugLog } from "./log.js";
import { getHomeDir, getTempDir, checkSilkWasmAvailable } from "./platform.js";

interface DiagnosticReport {
  platform: string;
  arch: string;
  nodeVersion: string;
  homeDir: string;
  tempDir: string;
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

  const silkWasm = await checkSilkWasmAvailable();
  if (!silkWasm) {
    warnings.push(
      "⚠️ silk-wasm is unavailable. QQ voice send/receive will not work. Ensure Node.js >= 16 and WASM support are available.",
    );
  }

  const report: DiagnosticReport = {
    platform,
    arch,
    nodeVersion,
    homeDir,
    tempDir,
    silkWasm,
    warnings,
  };

  debugLog("=== QQBot Environment Diagnostics ===");
  debugLog(`  Platform: ${platform} (${arch})`);
  debugLog(`  Node: ${nodeVersion}`);
  debugLog(`  Home: ${homeDir}`);
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

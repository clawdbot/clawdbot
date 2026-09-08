/** Shared Windows schtasks fixtures and temp-env helpers for daemon tests. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { PortUsage } from "../../infra/ports-types.js";
import type { killProcessTree as killProcessTreeImpl } from "../../process/kill-tree.js";
import type { MockFn } from "../../test-utils/vitest-mock-fn.js";
import { resolveTaskScriptPath } from "../schtasks.js";

export const schtasksResponses: Array<{ code: number; stdout: string; stderr: string }> = [];
export const schtasksCalls: string[][] = [];

/** Localized schtasks /Query /FO LIST /V snapshots used by runtime and inspect parsers. */
export const SCHTASKS_SPANISH_READY_LIST = [
  "Nombre de host: MINI-PC",
  "Nombre de tarea: \\OpenClaw Gateway",
  "Estado: Listo",
  "Último tiempo de ejecución: 1/09/2026 21:13:35",
  "Último resultado: 0",
  "Tarea que se ejecutará: C:\\Users\\minipc\\.openclaw\\gateway.vbs",
].join("\r\n");

export const SCHTASKS_GERMAN_READY_LIST = [
  "Aufgabenname: \\OpenClaw Gateway",
  "Status: Bereit",
  "Letzte Laufzeit: 02.08.2026 14:00:00",
  "Letztes Ergebnis: 0",
].join("\r\n");

export const inspectPortUsageMock: MockFn<
  (port: number, options?: { probeHosts?: readonly string[] }) => Promise<PortUsage>
> = vi.fn();
export const gatewayServiceProbeHostsMock: MockFn<() => Promise<readonly string[]>> = vi.fn();
export const killProcessTreeMock: MockFn<typeof killProcessTreeImpl> = vi.fn();

/** Runs a test with Windows-like daemon environment paths and cleans the temp dir. */
export async function withWindowsEnv(
  prefix: string,
  run: (params: { tmpDir: string; env: Record<string, string> }) => Promise<void>,
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const env = {
    USERPROFILE: tmpDir,
    APPDATA: path.join(tmpDir, "AppData", "Roaming"),
    OPENCLAW_PROFILE: "default",
    OPENCLAW_GATEWAY_PORT: "18789",
  };
  try {
    await run({ tmpDir, env });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export function resetSchtasksBaseMocks() {
  schtasksResponses.length = 0;
  schtasksCalls.length = 0;
  inspectPortUsageMock.mockReset();
  gatewayServiceProbeHostsMock.mockReset();
  gatewayServiceProbeHostsMock.mockResolvedValue(["127.0.0.1"]);
  killProcessTreeMock.mockReset();
}

export async function writeGatewayScript(
  env: Record<string, string>,
  port = Number(env.OPENCLAW_GATEWAY_PORT || "18789"),
) {
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(
    scriptPath,
    [
      "@echo off",
      `set "OPENCLAW_GATEWAY_PORT=${port}"`,
      `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\steipete\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js" gateway --port ${port}`,
      "",
    ].join("\r\n"),
    "utf8",
  );
}

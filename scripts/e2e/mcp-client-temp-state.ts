import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type McpClientTempState = {
  cleanup: () => void;
  root: string;
  stateDir: string;
  tokenFile: string;
};

export function createMcpClientTempState(params: {
  gatewayToken: string;
  tempRoot?: string;
}): McpClientTempState {
  const root = mkdtempSync(path.join(params.tempRoot ?? tmpdir(), "openclaw-mcp-client-"));
  const stateDir = path.join(root, "state");
  const tokenFile = path.join(root, "gateway.token");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(tokenFile, `${params.gatewayToken}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    cleanup: () => {
      rmSync(root, { force: true, recursive: true });
    },
    root,
    stateDir,
    tokenFile,
  };
}

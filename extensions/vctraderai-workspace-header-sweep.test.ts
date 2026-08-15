// W10 Lane A: every vendored BFF client that authenticates with the SHARED
// gateway token must stamp the gateway-trusted X-OpenClaw-Workspace header.
//
// The defect this pins: the shared OPENCLAW_GATEWAY_TOKEN carries no
// workspace identity, and the BFF's Lane-2 endpoints (catalogue/strategy
// reads, stage, registry mutations) resolve the workspace ONLY from that
// header -- so every such tool call answered 422
// openclaw_specialist_workspace_unset, deterministically, on the founder's
// live workspace ("roughly half of all tool calls fail", 2026-08-16). The
// PFM_AGENT_TOKEN cluster is exempt: that token IS workspace-scoped and the
// BFF binds identity from it.
//
// This sweep fails on ANY client copy that regresses, including future
// vendored plugins created from an old template.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const EXTENSIONS_DIR = path.resolve(__dirname);

function listInternalHttpClients(): string[] {
  return fs
    .readdirSync(EXTENSIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(EXTENSIONS_DIR, entry.name, "src", "internal-http-client.ts"))
    .filter((candidate) => fs.existsSync(candidate));
}

describe("vctraderai gateway-token clients stamp the workspace header", () => {
  const clients = listInternalHttpClients();

  it("finds the vendored client copies (non-vacuity control)", () => {
    // If this ever drops to zero the sweep is scanning the wrong place and
    // proves nothing -- fail loudly instead of passing vacuously.
    expect(clients.length).toBeGreaterThan(50);
  });

  it("every OPENCLAW_GATEWAY_TOKEN client sends x-openclaw-workspace", () => {
    const offenders: string[] = [];
    for (const file of clients) {
      const source = fs.readFileSync(file, "utf8");
      const usesGatewayToken = source.includes('readEnv("OPENCLAW_GATEWAY_TOKEN")');
      if (!usesGatewayToken) {
        continue; // PFM_AGENT_TOKEN cluster: workspace-scoped by the token itself.
      }
      const readsWorkspace =
        source.includes('readEnv("PFM_AGENT_WORKSPACE_ID")') ||
        source.includes('readEnv("PFM_WORKSPACE_ID")');
      const stampsHeader = source.includes('"x-openclaw-workspace"');
      if (!readsWorkspace || !stampsHeader) {
        offenders.push(path.relative(EXTENSIONS_DIR, file));
      }
    }
    expect(offenders, "gateway-token clients missing the workspace header").toEqual([]);
  });
});

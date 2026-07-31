/**
 * Real-runtime proof for "reuse the current metadata snapshot across every
 * configured agent".
 *
 * WHAT IS REAL (no mocks, no vitest):
 *   - `resolveConfiguredAgentWorkspaceDirs` from src/agents/agent-scope-config.ts,
 *     driven against a real multi-agent config and a real temp state dir.
 *   - `loadPluginMetadataSnapshot` from src/plugins/plugin-metadata-snapshot.ts —
 *     a genuine on-disk discovery pass rooted at a temp `OPENCLAW_STATE_DIR`,
 *     producing a real `PluginMetadataSnapshot`, not a hand-built literal.
 *   - `setCurrentPluginMetadataSnapshot` / `getCurrentPluginMetadataSnapshot` /
 *     `clearCurrentPluginMetadataSnapshot` — the real process-wide single-slot
 *     state module under test.
 *
 * WHAT IS REPRODUCED RATHER THAN INVOKED:
 *   - The two publish sites. Booting a full gateway to reach
 *     `prepareGatewayServerBootstrap()` and `startGatewayCoreRuntime()` would
 *     drag in sockets, channels and plugin activation. Instead each scenario
 *     calls `setCurrentPluginMetadataSnapshot` with the *exact* option shape
 *     those two call sites pass, so the seam under test — how the published
 *     compatibility set is matched by later readers — is fully real. Scenario 4
 *     pins the old reload shape to prove the regression this fixes.
 *
 * SCENARIOS:
 *   1. Every configured agent resolves to its own workspace dir.
 *   2. Startup publish → all agent workspaces hit; an unconfigured one misses.
 *   3. Reload publish (fixed shape) → all agent workspaces still hit.
 *   4. Reload publish (pre-fix shape: no compatibleConfigs/compatibleWorkspaceDirs)
 *      → non-gateway agents miss. This is the bug, pinned.
 *
 * RUN: pnpm tsx scripts/proof-plugin-metadata-compatible-configs.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfiguredAgentWorkspaceDirs } from "../src/agents/agent-scope-config.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  getCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../src/plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../src/plugins/current-plugin-metadata-state.js";
import { loadPluginMetadataSnapshot } from "../src/plugins/plugin-metadata-snapshot.js";

let checks = 0;

function assert(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${description}`);
  }
  console.log(`  ok  ${description}`);
}

function main(): void {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proof-compat-configs-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const gatewayWorkspace = path.join(stateDir, "workspace-gateway");
    const tankWorkspace = path.join(stateDir, "workspace-tank-custom");
    for (const dir of [gatewayWorkspace, tankWorkspace]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // A real multi-agent roster: one agent with an explicit workspace, one
    // falling through to the state-dir default, one default agent.
    const cfg = {
      agents: {
        entries: {
          main: { workspace: gatewayWorkspace },
          tank: { workspace: tankWorkspace },
          shiva: {},
        },
      },
      plugins: { allow: ["demo"] },
    } as unknown as OpenClawConfig;

    console.log("\n[1] resolveConfiguredAgentWorkspaceDirs covers every configured agent");
    const workspaceDirs = resolveConfiguredAgentWorkspaceDirs(cfg, env);
    console.log(`      resolved: ${JSON.stringify(workspaceDirs)}`);
    assert(workspaceDirs.includes(gatewayWorkspace), "includes main's explicit workspace");
    assert(workspaceDirs.includes(tankWorkspace), "includes tank's explicit workspace");
    assert(
      workspaceDirs.some((dir) => dir.endsWith(`workspace-shiva`)),
      "includes shiva's state-dir default workspace",
    );
    assert(new Set(workspaceDirs).size === workspaceDirs.length, "result is deduplicated");

    const shivaWorkspace = workspaceDirs.find((dir) => dir.endsWith("workspace-shiva"));
    if (!shivaWorkspace) {
      throw new Error("ASSERTION FAILED: shiva workspace missing from resolver output");
    }
    const strangerWorkspace = path.join(stateDir, "workspace-not-configured");

    // A real discovery pass against the temp state dir.
    const snapshot = loadPluginMetadataSnapshot({
      config: cfg,
      env,
      stateDir,
      workspaceDir: gatewayWorkspace,
    });
    assert(typeof snapshot.policyHash === "string", "real snapshot loaded from disk");

    console.log("\n[2] startup publish serves every configured agent workspace");
    clearCurrentPluginMetadataSnapshot();
    setCurrentPluginMetadataSnapshot(snapshot, {
      config: cfg,
      // exactly the shape prepareGatewayServerBootstrap() publishes
      compatibleConfigs: [cfg, cfg, cfg],
      compatibleWorkspaceDirs: workspaceDirs,
      env,
      workspaceDir: gatewayWorkspace,
    });
    for (const [label, dir] of [
      ["main", gatewayWorkspace],
      ["tank", tankWorkspace],
      ["shiva", shivaWorkspace],
    ] as const) {
      assert(
        getCurrentPluginMetadataSnapshot({ config: cfg, workspaceDir: dir }) === snapshot,
        `${label} hits the fast path with its own workspace`,
      );
    }
    assert(
      getCurrentPluginMetadataSnapshot({ config: cfg, workspaceDir: strangerWorkspace }) ===
        undefined,
      "an unconfigured workspace still misses (no blanket bypass)",
    );

    console.log("\n[3] config reload keeps the compatibility set");
    clearCurrentPluginMetadataSnapshot();
    setCurrentPluginMetadataSnapshot(snapshot, {
      config: cfg,
      // exactly the shape startGatewayCoreRuntime()'s reload path publishes
      compatibleConfigs: [cfg],
      compatibleWorkspaceDirs: resolveConfiguredAgentWorkspaceDirs(cfg, env),
      env,
      workspaceDir: gatewayWorkspace,
    });
    for (const [label, dir] of [
      ["main", gatewayWorkspace],
      ["tank", tankWorkspace],
      ["shiva", shivaWorkspace],
    ] as const) {
      assert(
        getCurrentPluginMetadataSnapshot({ config: cfg, workspaceDir: dir }) === snapshot,
        `${label} still hits after a config reload`,
      );
    }

    console.log("\n[4] regression pin: the pre-fix reload shape loses every non-gateway agent");
    clearCurrentPluginMetadataSnapshot();
    setCurrentPluginMetadataSnapshot(snapshot, {
      // pre-fix: no compatibleConfigs, no compatibleWorkspaceDirs
      config: cfg,
      env,
      workspaceDir: gatewayWorkspace,
    });
    assert(
      getCurrentPluginMetadataSnapshot({ config: cfg, workspaceDir: gatewayWorkspace }) ===
        snapshot,
      "the gateway's own workspace still hit before the fix (why this went unnoticed)",
    );
    for (const [label, dir] of [
      ["tank", tankWorkspace],
      ["shiva", shivaWorkspace],
    ] as const) {
      assert(
        getCurrentPluginMetadataSnapshot({ config: cfg, workspaceDir: dir }) === undefined,
        `${label} missed before the fix — every lookup fell through to a full manifest scan`,
      );
    }

    clearCurrentPluginMetadataSnapshot();
    console.log(`\nAll runtime assertions passed. (${checks} checks)`);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

main();

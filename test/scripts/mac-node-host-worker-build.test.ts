import fs from "node:fs";
import { isBuiltin } from "node:module";
import { describe, expect, it } from "vitest";
import { createMacNodeHostWorkerBuildPlugin } from "../../scripts/lib/mac-node-host-worker-build-plugin.mts";
import { WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID } from "../../scripts/lib/worker-deploy-build-plugin.mts";
import config from "../../tsdown.mac-node-host-worker.config.ts";

describe("macOS node-host worker build", () => {
  it("bundles a single source-bound runtime without native optional dependencies", () => {
    expect(config.entry).toEqual({
      "node-host-worker": "src/node-host/mac-node-host-worker-entry.ts",
    });
    expect(config.outDir).toBe("apps/macos/.build/node-host-worker");
    expect(config.dts).toBe(false);
    expect(config.outputOptions).toEqual({ codeSplitting: false });
    expect(config.define).toMatchObject({
      WORKER_DEPLOY_BUILD: "true",
      MAC_NODE_HOST_WORKER_SOURCE_COMMIT: expect.any(String),
    });
    expect(config.alias).toMatchObject({
      bufferutil: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      fsevents: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      kerberos: WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
      "utf-8-validate": WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
    });
    expect(config.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "openclaw:worker-deploy" })]),
    );
    const alwaysBundle = config.deps?.alwaysBundle;
    expect(alwaysBundle).toBeTypeOf("function");
    if (typeof alwaysBundle !== "function") {
      throw new Error("node-host worker config must own dependency bundling");
    }
    expect(alwaysBundle("json5", undefined)).toBe(true);
    expect(alwaysBundle("node:fs", undefined)).toBe(!isBuiltin("node:fs"));
  });

  it("keeps the signed composition explicitly CUA-free", () => {
    const sourcePath = "src/node-host/mac-node-host-plugin-definitions.ts";
    const source = fs.readFileSync(sourcePath, "utf8");
    const generated = createMacNodeHostWorkerBuildPlugin().transform(source, sourcePath);

    const pluginIds = [...(generated?.matchAll(/extensions\/(.+?)\/index\.js/g) ?? [])].map(
      (match) => match[1],
    );
    expect(pluginIds).toEqual([
      "acpx",
      "anthropic",
      "browser",
      "codex",
      "file-transfer",
      "google-meet",
      "logbook",
      "ollama",
      "opencode",
      "teams-meetings",
      "zoom-meetings",
    ]);
    expect(pluginIds).not.toContain("cua-computer");
    expect(pluginIds).not.toContain("linux-node");
  });
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

const tempRoots: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-loader", tempRoots);
}

const mkdirSafe = mkdirSafeDir;

afterEach(() => {
  cleanupTrackedTempDirs(tempRoots);
});

describe("plugin loader git path regression", () => {
  it("loads git-style package extension entries when they import plugin-sdk subpaths (#49806)", async () => {
    const copiedExtensionRoot = path.join(makeTempDir(), "extensions", "imessage");
    const copiedSourceDir = path.join(copiedExtensionRoot, "src");
    const copiedPluginSdkDir = path.join(copiedExtensionRoot, "plugin-sdk");
    mkdirSafe(copiedSourceDir);
    mkdirSafe(copiedPluginSdkDir);
    const sourceLoaderBaseFile = path.join(copiedSourceDir, "__jiti-base__.mjs");
    fs.writeFileSync(sourceLoaderBaseFile, "export {};\n", "utf-8");
    fs.writeFileSync(
      path.join(copiedSourceDir, "channel.runtime.ts"),
      `import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-send-deps";
import { PAIRING_APPROVED_MESSAGE } from "../runtime-api.js";

export const copiedRuntimeMarker = {
  resolveOutboundSendDep,
  PAIRING_APPROVED_MESSAGE,
};
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(copiedExtensionRoot, "runtime-api.ts"),
      `export const PAIRING_APPROVED_MESSAGE = "paired";
`,
      "utf-8",
    );
    const copiedChannelRuntimeShim = path.join(copiedPluginSdkDir, "outbound-send-deps.ts");
    fs.writeFileSync(
      copiedChannelRuntimeShim,
      `export function resolveOutboundSendDep() {
  return "shimmed";
}
`,
      "utf-8",
    );
    const copiedChannelRuntime = path.join(copiedExtensionRoot, "src", "channel.runtime.ts");
    const script = `
      import { createJiti } from "jiti";
      const withoutAlias = createJiti(${JSON.stringify(sourceLoaderBaseFile)}, {
        interopDefault: true,
        tryNative: false,
        extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      });
      let withoutAliasThrew = false;
      try {
        withoutAlias(${JSON.stringify(copiedChannelRuntime)});
      } catch {
        withoutAliasThrew = true;
      }
      const withAlias = createJiti(${JSON.stringify(sourceLoaderBaseFile)}, {
        interopDefault: true,
        tryNative: false,
        extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
        alias: {
          "openclaw/plugin-sdk/outbound-send-deps": ${JSON.stringify(copiedChannelRuntimeShim)},
        },
      });
      const mod = withAlias(${JSON.stringify(copiedChannelRuntime)});
      console.log(JSON.stringify({
        withoutAliasThrew,
        marker: mod.copiedRuntimeMarker?.PAIRING_APPROVED_MESSAGE,
        dep: mod.copiedRuntimeMarker?.resolveOutboundSendDep?.(),
      }));
    `;
    const raw = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
    const result = JSON.parse(raw) as {
      withoutAliasThrew: boolean;
      marker?: string;
      dep?: string;
    };
    expect(result.withoutAliasThrew).toBe(true);
    expect(result.marker).toBe("paired");
    expect(result.dep).toBe("shimmed");
  });
});

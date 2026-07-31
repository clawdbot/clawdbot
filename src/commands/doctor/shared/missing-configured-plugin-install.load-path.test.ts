import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearCurrentPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata-state.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import {
  detectConfiguredPluginInstallHealthIssues,
  repairMissingConfiguredPluginInstalls,
} from "./missing-configured-plugin-install.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeProviderPlugin(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "dist", "index.js"), "export default {};\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/kilocode-provider",
      version: "2026.7.1",
      openclaw: {
        extensions: ["./index.ts"],
        runtimeExtensions: ["./dist/index.js"],
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "kilocode",
      enabledByDefault: true,
      providers: ["kilocode"],
      configSchema: { type: "object", properties: {} },
    }),
    "utf8",
  );
}

describe("configured plugin install health for explicit load paths", () => {
  it("does not install a provider plugin already present at a configured load path", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-load-path-provider-"));
    tempDirs.push(rootDir);
    const pluginDir = path.join(rootDir, "kilocode-provider");
    writeProviderPlugin(pluginDir);

    const cfg = {
      plugins: {
        load: { paths: [pluginDir] },
      },
    };
    const env = {
      KILOCODE_API_KEY: "test-key",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
      VITEST: "true",
    };
    const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
    expect(snapshot.plugins.map((plugin) => plugin.id)).toContain("kilocode");

    const issues = await detectConfiguredPluginInstallHealthIssues({
      cfg,
      env,
    });
    expect(issues).toStrictEqual([]);

    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair).toMatchObject({
      changes: [],
      records: {},
      warnings: [],
    });
  });
});

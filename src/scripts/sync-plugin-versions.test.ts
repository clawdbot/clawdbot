import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncPluginVersions } from "../../scripts/sync-plugin-versions.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";

const tempDirs: string[] = [];

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("syncPluginVersions", () => {
  afterEach(() => {
    cleanupTempDirs(tempDirs);
  });

  it("preserves workspace openclaw devDependencies and plugin host floors", () => {
    const rootDir = makeTempDir(tempDirs, "openclaw-sync-plugin-versions-");

    writeJson(path.join(rootDir, "package.json"), {
      name: "openclaw",
      version: "2026.4.1",
    });
    writeJson(path.join(rootDir, "extensions/bluebubbles/package.json"), {
      name: "@openclaw/bluebubbles",
      version: "2026.3.30",
      devDependencies: {
        openclaw: "workspace:*",
      },
      peerDependencies: {
        openclaw: ">=2026.3.30",
      },
      openclaw: {
        install: {
          minHostVersion: ">=2026.3.30",
        },
        compat: {
          pluginApi: ">=2026.3.30",
        },
        build: {
          openclawVersion: "2026.3.30",
        },
      },
    });

    const summary = syncPluginVersions(rootDir);
    const updatedPackage = JSON.parse(
      fs.readFileSync(path.join(rootDir, "extensions/bluebubbles/package.json"), "utf8"),
    ) as {
      version?: string;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      openclaw?: {
        install?: {
          minHostVersion?: string;
        };
        compat?: {
          pluginApi?: string;
        };
        build?: {
          openclawVersion?: string;
        };
      };
    };

    expect(summary.updated).toContain("@openclaw/bluebubbles");
    expect(updatedPackage.version).toBe("2026.4.1");
    expect(updatedPackage.devDependencies?.openclaw).toBe("workspace:*");
    expect(updatedPackage.peerDependencies?.openclaw).toBe(">=2026.4.1");
    expect(updatedPackage.openclaw?.install?.minHostVersion).toBe(">=2026.3.30");
    expect(updatedPackage.openclaw?.compat?.pluginApi).toBe(">=2026.4.1");
    expect(updatedPackage.openclaw?.build?.openclawVersion).toBe("2026.4.1");
  });
});

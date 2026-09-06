import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("FaceTime plugin manifest", () => {
  it("declares an installed-native Apple Silicon plugin at the current host contract", () => {
    const packageManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const pluginManifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );

    expect(packageManifest.openclaw.extensions).toEqual(["./index.ts"]);
    expect(packageManifest.openclaw.runtimeExtensions).toBeUndefined();
    expect(packageManifest.license).toBe("MIT");
    expect(packageManifest.author).toBe("OpenClaw contributors");
    expect(packageManifest.homepage).toBe("https://docs.openclaw.ai/plugins/facetime");
    expect(packageManifest.bugs.url).toBe("https://github.com/openclaw/openclaw/issues");
    expect(packageManifest.repository).toEqual({
      type: "git",
      url: "https://github.com/openclaw/openclaw",
      directory: "extensions/facetime",
    });
    expect(packageManifest.os).toEqual(["darwin"]);
    expect(packageManifest.cpu).toEqual(["arm64"]);
    expect(packageManifest.files).toEqual(
      expect.arrayContaining(["index.ts", "runtime-api.ts", "src/runtime.ts"]),
    );
    expect(packageManifest.files).not.toContain("runtime-entry.ts");
    expect(packageManifest.files.some((file: string) => file.startsWith("helper/"))).toBe(false);
    expect(packageManifest.files.some((file: string) => file.startsWith("native/"))).toBe(false);
    expect(packageManifest.files).not.toContain("scripts/build-capture.sh");
    expect(packageManifest.files).not.toContain("scripts/build-helper-macabi.sh");
    expect(packageManifest.files).toContain("scripts/stage-helper.sh");
    expect(packageManifest.files).toContain("scripts/verify-native-helper.sh");
    expect(packageManifest.files).not.toContain("dist/");
    expect(packageManifest.files).not.toContain("doctor-contract-api.ts");
    expect(packageManifest.files).toContain("LICENSE");
    expect(packageManifest.files).toContain("THIRD_PARTY_NOTICES.md");
    expect(packageManifest.files).toContain("skills/facetime/SKILL.md");
    expect(packageManifest.devDependencies.openclaw).toBe("workspace:*");
    expect(packageManifest.private).toBe(true);
    expect(packageManifest.peerDependencies.openclaw).toBe(">=2026.8.1");
    expect(packageManifest.openclaw.install).toBeUndefined();
    expect(packageManifest.openclaw.compat.pluginApi).toBe(">=2026.8.1");
    expect(packageManifest.openclaw.build).toEqual({
      bundledDist: false,
      openclawVersion: "2026.8.1",
    });
    expect(packageManifest.openclaw.release).toBeUndefined();
    expect(pluginManifest.enabledByDefault).toBe(false);
    expect(pluginManifest.skills).toEqual(["./skills"]);
    expect(pluginManifest.contracts.tools).toEqual(["facetime_call"]);
    expect(pluginManifest.configSchema.properties.helperPort).toBeUndefined();
    expect(pluginManifest.configSchema.properties.helperHost).toBeUndefined();
    expect(pluginManifest.configSchema.properties.realtime.properties.toolPolicy.enum).toEqual([
      "safe-read-only",
      "owner",
      "none",
    ]);
  });
});

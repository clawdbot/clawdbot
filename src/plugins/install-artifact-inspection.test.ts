import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  inspectBundlePluginArtifact,
  inspectNativePluginArtifact,
} from "./install-artifact-inspection.js";
import { installPluginFromPath } from "./install-package.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin install artifact inspection", () => {
  it("classifies native plugins as canonically mapped", () => {
    expect(inspectNativePluginArtifact()).toEqual({
      format: "openclaw",
      mapped: ["plugin"],
      unavailable: [],
    });
  });

  it("separates mapped and detect-only bundle capabilities deterministically", () => {
    expect(
      inspectBundlePluginArtifact({
        format: "claude",
        capabilities: ["outputStyles", "skills", "agents", "mcpServers", "skills"],
      }),
    ).toEqual({
      format: "claude",
      mapped: ["agents", "mcpServers", "outputStyles", "skills"],
      unavailable: [],
    });
  });

  it("reports cursor agent directories as unavailable because the runtime never loads them", () => {
    expect(
      inspectBundlePluginArtifact({
        format: "cursor",
        capabilities: ["agents", "commands", "skills"],
      }),
    ).toEqual({
      format: "cursor",
      mapped: ["commands", "skills"],
      unavailable: ["agents"],
    });
  });

  it("returns canonical inspection from the verified bundle install path", async () => {
    const root = tempDirs.make("openclaw-plugin-artifact-inspection-");
    const bundle = join(root, "bundle");
    await mkdir(join(bundle, ".claude-plugin"), { recursive: true });
    await mkdir(join(bundle, "skills", "triage"), { recursive: true });
    await mkdir(join(bundle, "agents", "reviewer"), { recursive: true });
    await writeFile(
      join(bundle, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "inspection-bundle", version: "1.0.0" }),
      "utf8",
    );

    const result = await installPluginFromPath({
      path: bundle,
      extensionsDir: join(root, "extensions"),
      dryRun: true,
    });

    expect(result).toMatchObject({
      ok: true,
      artifactInspection: {
        format: "claude",
        mapped: ["agents", "skills"],
        unavailable: [],
      },
    });
  });

  it("preflights a cursor bundle with detected but unmapped agents", async () => {
    const root = tempDirs.make("openclaw-plugin-artifact-inspection-cursor-");
    const bundle = join(root, "bundle");
    await mkdir(join(bundle, ".cursor-plugin"), { recursive: true });
    await mkdir(join(bundle, "skills", "triage"), { recursive: true });
    await mkdir(join(bundle, ".cursor", "agents"), { recursive: true });
    await writeFile(
      join(bundle, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "cursor-inspection-bundle", version: "1.0.0" }),
      "utf8",
    );

    const result = await installPluginFromPath({
      path: bundle,
      extensionsDir: join(root, "extensions"),
      dryRun: true,
    });

    expect(result).toMatchObject({
      ok: true,
      artifactInspection: {
        format: "cursor",
        mapped: ["skills"],
        unavailable: ["agents"],
      },
    });
  });
});

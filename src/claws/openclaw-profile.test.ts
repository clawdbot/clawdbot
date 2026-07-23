import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawOpenClawProfile } from "./schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("OpenClaw profile schema", () => {
  it("accepts typed settings", () => {
    const result = parseClawOpenClawProfile({
      schemaVersion: 1,
      agent: {
        tools: {
          profile: "coding",
          alsoAllow: ["cron"],
          deny: ["exec"],
          fs: { workspaceOnly: true },
        },
        memory: {
          search: {
            enabled: true,
            rememberAcrossConversations: true,
            sources: ["memory", "sessions"],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects disabled host filesystem confinement", () => {
    const result = parseClawOpenClawProfile({
      schemaVersion: 1,
      agent: { tools: { fs: { workspaceOnly: false } } },
    });

    expect(result.ok).toBe(false);
  });

  it("rejects invalid profile policy", () => {
    for (const agent of [
      { tools: { profile: "future-profile" } },
      { tools: { allow: ["read"], alsoAllow: ["write"] } },
      { memory: { search: { provider: "openai" } } },
      { memory: { search: { sources: ["sessions"] } } },
    ]) {
      expect(parseClawOpenClawProfile({ schemaVersion: 1, agent }).ok).toBe(false);
    }
  });
});

describe("OpenClaw profile reader", () => {
  it("loads and integrity-binds a metadata-referenced profile", async () => {
    const root = tempDirs.make("openclaw-claw-profile-");
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "@acme/github-triage",
        version: "3.2.1",
        openclaw: { claw: "CLAW.md" },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "CLAW.md"),
      [
        "---",
        "schemaVersion: 1",
        "agent:",
        "  id: triage",
        "metadata:",
        "  openclaw.config: profiles/openclaw.yml",
        "---",
        "",
        "# GitHub Triage",
      ].join("\n"),
      "utf8",
    );
    const profilePath = join(root, "profiles", "openclaw.yml");
    await writeFile(
      profilePath,
      [
        "schemaVersion: 1",
        "agent:",
        "  tools:",
        "    profile: coding",
        "    deny: [exec]",
        "    fs:",
        "      workspaceOnly: true",
      ].join("\n"),
      "utf8",
    );

    const first = await readClawManifestFile(root);
    expect(first).toMatchObject({
      ok: true,
      manifest: {
        metadata: { "openclaw.config": "profiles/openclaw.yml" },
      },
      openClawProfile: {
        schemaVersion: 1,
        agent: {
          tools: { profile: "coding", deny: ["exec"], fs: { workspaceOnly: true } },
        },
      },
    });
    if (!first.ok) {
      throw new Error("expected OpenClaw profile to parse");
    }

    await writeFile(
      profilePath,
      "schemaVersion: 1\nagent:\n  tools:\n    profile: messaging\n",
      "utf8",
    );
    const second = await readClawManifestFile(root);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      throw new Error("expected changed OpenClaw profile to parse");
    }
    expect(second.source.integrity).not.toBe(first.source.integrity);
  });

  it("rejects a hardlinked profile", async () => {
    const root = tempDirs.make("openclaw-claw-profile-hardlink-");
    await mkdir(join(root, "profiles"));
    await writeFile(
      join(root, "openclaw.claw.json"),
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "triage" },
        metadata: { "openclaw.config": "profiles/openclaw.yml" },
      }),
      "utf8",
    );
    const source = join(root, "source.yml");
    await writeFile(source, "schemaVersion: 1\nagent: {}\n", "utf8");
    await link(source, join(root, "profiles", "openclaw.yml"));

    const result = await readClawManifestFile(join(root, "openclaw.claw.json"));

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "openclaw_profile_unsafe" })],
    });
  });
  it("rejects a symlinked profile at the read boundary", async () => {
    const root = tempDirs.make("openclaw-claw-profile-symlink-");
    await mkdir(join(root, "profiles"));
    const path = join(root, "openclaw.claw.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "triage" },
        metadata: { "openclaw.config": "profiles/openclaw.yml" },
      }),
      "utf8",
    );
    await writeFile(join(root, "source.yml"), "schemaVersion: 1\nagent: {}\n", "utf8");
    await symlink("../source.yml", join(root, "profiles", "openclaw.yml"));

    const result = await readClawManifestFile(path);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "openclaw_profile_unsafe" })],
    });
  });

  it("rejects an escaping profile path", async () => {
    const root = tempDirs.make("openclaw-claw-profile-path-");
    const path = join(root, "openclaw.claw.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "triage" },
        metadata: { "openclaw.config": "../openclaw.yml" },
      }),
      "utf8",
    );

    const result = await readClawManifestFile(path);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "invalid_openclaw_profile_path" })],
    });
  });

  it("rejects an empty declared profile path", async () => {
    const root = tempDirs.make("openclaw-claw-profile-empty-path-");
    const path = join(root, "openclaw.claw.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        agent: { id: "triage" },
        metadata: { "openclaw.config": "" },
      }),
      "utf8",
    );

    const result = await readClawManifestFile(path);

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "invalid_openclaw_profile_path" })],
    });
  });
});

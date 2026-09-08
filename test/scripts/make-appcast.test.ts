// Make Appcast tests cover release appcast script behavior.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = "scripts/make_appcast.sh";

describe("make_appcast cleanup", () => {
  it("does not reference release notes before their path is assigned", () => {
    const script = readFileSync(scriptPath, "utf8");
    const setupBlock = script.slice(
      script.indexOf('TMP_DIR="$(mktemp -d)"'),
      script.indexOf('cp -f "$ZIP" "$TMP_DIR/$ZIP_NAME"'),
    );

    expect(setupBlock).toContain('NOTES_HTML=""');
    expect(setupBlock.indexOf('NOTES_HTML=""')).toBeLessThan(
      setupBlock.indexOf("trap cleanup EXIT"),
    );
    expect(setupBlock).toContain(
      'if [[ -n "$NOTES_HTML" && "${KEEP_SPARKLE_NOTES:-0}" != "1" ]]; then',
    );
    expect(setupBlock).toContain('rm -f "$NOTES_HTML"');
  });

  it.skipIf(process.platform === "win32").each([
    ["2026.8.2", undefined],
    ["2026.8.2-beta.1", "beta"],
    ["2026.8.2.beta.1", "beta"],
    ["2026.8.33", "extended-stable"],
    ["2026.8.2-alpha.1", "refused"],
  ])("generates the correct Sparkle channel for %s with system Bash", (version, channel) => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-appcast-"));
    try {
      const scripts = path.join(root, "scripts");
      mkdirSync(scripts);
      copyFileSync(scriptPath, path.join(scripts, "make_appcast.sh"));
      writeFileSync(
        path.join(scripts, "changelog-to-html.sh"),
        "#!/bin/sh\necho '<p>Release notes</p>'\n",
        { mode: 0o755 },
      );
      const zip = path.join(root, `OpenClaw-${version}.zip`);
      writeFileSync(zip, "fixture archive");
      writeFileSync(path.join(root, "appcast.xml"), "previous feed");
      const generator = path.join(root, "generate-appcast");
      writeFileSync(
        generator,
        `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(path.join(__dirname, "arguments.json"), JSON.stringify(args));
fs.writeFileSync(path.join(args.at(-1), "appcast.xml"), '<rss><channel><item><sparkle:shortVersionString>${version}</sparkle:shortVersionString><enclosure sparkle:edSignature="fixture-signature" /></item></channel></rss>');
`,
        { mode: 0o755 },
      );
      const result = spawnSync("/bin/bash", [path.join(scripts, "make_appcast.sh"), zip], {
        encoding: "utf8",
        env: {
          ...process.env,
          SPARKLE_PRIVATE_KEY_FILE: path.join(root, "unused-fixture-key"),
          SPARKLE_GENERATE_APPCAST: generator,
          SPARKLE_RELEASE_VERSION: version,
          KEEP_SPARKLE_NOTES: "0",
        },
      });
      const argsFile = path.join(root, "arguments.json");
      if (channel === "refused") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Alpha releases do not ship via Sparkle");
        expect(existsSync(argsFile)).toBe(false);
        expect(readFileSync(path.join(root, "appcast.xml"), "utf8")).toBe("previous feed");
        return;
      }
      expect(result.status, result.stderr).toBe(0);
      const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
      expect(args).toContain("--embed-release-notes");
      if (channel) {
        expect(args.slice(args.indexOf("--channel"), args.indexOf("--channel") + 2)).toEqual([
          "--channel",
          channel,
        ]);
      } else {
        expect(args).not.toContain("--channel");
      }
      expect(args).not.toContain("");
      expect(readFileSync(path.join(root, "appcast.xml"), "utf8")).toContain(
        `<sparkle:shortVersionString>${version}</sparkle:shortVersionString>`,
      );
      expect(existsSync(path.join(root, `OpenClaw-${version}.html`))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the host-architecture Sparkle tool and requires a signed entry", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('if [[ -n "${SPARKLE_GENERATE_APPCAST:-}" ]]');
    expect(script).toContain('"$ROOT/apps/macos/.build/$host_arch"');
    expect(script).toContain('if [[ -d "$bundled_root" ]]');
    expect(script.indexOf('"$ROOT/apps/macos/.build/$host_arch"')).toBeLessThan(
      script.indexOf("command -v generate_appcast"),
    );
    expect(script).toContain("is missing sparkle:edSignature");
  });
});

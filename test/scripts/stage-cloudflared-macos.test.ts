import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

describe.runIf(process.platform === "darwin")("bundled browser sign-in helper", () => {
  it.each(["arm64", "x86_64", "wrong-architecture", "wrong-checksum"])(
    "verifies cached and downloaded payloads before staging: %s",
    async (scenario) => {
      const root = tempDirs.make("openclaw-cloudflared-stage-");
      const scripts = path.join(root, "scripts");
      const cache = path.join(root, "apps/macos/.build/cloudflared/2026.8.3");
      const fixture = path.join(root, "fixture");
      const tools = path.join(root, "tools");
      const destination = path.join(root, "resources/cloudflared");
      const arch = scenario === "x86_64" ? "x86_64" : "arm64";
      for (const directory of [
        path.join(scripts, "lib"),
        cache,
        fixture,
        tools,
        path.join(destination, arch),
      ]) {
        mkdirSync(directory, { recursive: true });
      }
      copyFileSync(
        "scripts/stage-cloudflared-macos.sh",
        path.join(scripts, "stage-cloudflared-macos.sh"),
      );
      // lipo reads the actual Mach-O architecture; the inert fixture is never executed.
      const binary = Buffer.alloc(32);
      binary.writeUInt32LE(0xfeedfacf, 0);
      binary.writeUInt32LE(
        arch === "x86_64" || scenario === "wrong-architecture" ? 0x01000007 : 0x0100000c,
        4,
      );
      binary.writeUInt32LE(arch === "x86_64" || scenario === "wrong-architecture" ? 3 : 0, 8);
      binary.writeUInt32LE(2, 12);
      writeFileSync(path.join(fixture, "cloudflared"), binary);
      const asset = `cloudflared-darwin-${arch === "arm64" ? "arm64" : "amd64"}.tgz`;
      const archive = path.join(cache, asset);
      await tar.c({ file: archive, gzip: true, cwd: fixture }, ["cloudflared"]);
      const license = "Cloudflared license fixture\n";
      writeFileSync(path.join(cache, "LICENSE"), license);
      writeFileSync(
        path.join(scripts, "lib/cloudflared-macos.json"),
        JSON.stringify({
          version: "2026.8.3",
          licenseSha256: digest(license),
          artifacts: {
            [arch]: {
              asset,
              sha256:
                scenario === "wrong-checksum" ? "0".repeat(64) : digest(readFileSync(archive)),
            },
          },
        }),
      );
      // A corrupt cache must be downloaded and checked again, never copied into the app.
      const curl = path.join(tools, "curl");
      writeFileSync(
        curl,
        `#!/bin/bash
set -euo pipefail
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --output ]]; then cp "$fixture_archive" "$2"; exit 0; fi
  shift
done
exit 2
`,
      );
      chmodSync(curl, 0o755);
      const staged = path.join(destination, arch, "cloudflared");
      writeFileSync(staged, "previous helper");
      const result = spawnSync(
        "/bin/bash",
        [path.join(scripts, "stage-cloudflared-macos.sh"), arch, destination],
        {
          encoding: "utf8",
          env: {
            PATH: `${tools}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
            TMPDIR: root,
            fixture_archive: archive,
          },
        },
      );
      if (scenario.startsWith("wrong-")) {
        expect(result.status).not.toBe(0);
        expect(readFileSync(staged, "utf8")).toBe("previous helper");
        expect(result.stderr).toContain(
          scenario === "wrong-checksum" ? "sha256 mismatch" : "expected arm64 executable",
        );
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(staged)).toEqual(binary);
        expect(statSync(staged).mode & 0o777).toBe(0o755);
        expect(readFileSync(path.join(destination, "LICENSE"), "utf8")).toBe(license);
        expect(
          JSON.parse(readFileSync(path.join(destination, "manifest.json"), "utf8")).version,
        ).toBe("2026.8.3");
      }
    },
  );
});

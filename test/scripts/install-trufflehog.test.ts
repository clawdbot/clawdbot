import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const SCRIPT = "scripts/install-trufflehog.sh";
const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function runBash(command: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_TRUFFLEHOG_SOURCE_ONLY: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("scripts/install-trufflehog.sh", () => {
  it("is an opt-in shared environment setup capability", () => {
    const action = readFileSync(".github/actions/setup-node-env/action.yml", "utf8");
    expect(action).toContain("install-trufflehog:");
    expect(action).toContain("if: inputs.install-trufflehog == 'true'");
    expect(action).toContain("run: bash scripts/install-trufflehog.sh");
  });

  it("is enabled during every Linux Testbox hydration before handoff", () => {
    for (const workflow of [
      ".github/workflows/ci-check-testbox.yml",
      ".github/workflows/ci-check-arm-testbox.yml",
      ".github/workflows/ci-build-artifacts-testbox.yml",
    ]) {
      const text = readFileSync(workflow, "utf8");
      const install = text.indexOf('install-trufflehog: "true"');
      const handoff = text.indexOf("uses: useblacksmith/run-testbox@");

      expect(install, `${workflow} must provision TruffleHog`).toBeGreaterThanOrEqual(0);
      expect(handoff, `${workflow} must hand off to run-testbox`).toBeGreaterThan(install);
    }
  });

  it("pins the reviewed Linux checksums for both Testbox architectures", () => {
    const output = runBash(
      [
        `source ${SCRIPT}`,
        "printf 'amd64=%s\\n' \"$(trufflehog_sha256 amd64)\"",
        "printf 'arm64=%s\\n' \"$(trufflehog_sha256 arm64)\"",
      ].join("\n"),
    );

    expect(output).toContain(
      "amd64=f6d1106b85107d79527ed7a5b98b592beadd8b770dc3c9e8c1ad99e1b2cf127e",
    );
    expect(output).toContain(
      "arm64=9d9c2ec4ea36a089a9c5aaafe1969d176013ddf9f44d68e8cd75291aed8c83ed",
    );
  });

  it("does not download TruffleHog again when the pinned version is installed", () => {
    const root = makeTempDir(tempDirs, "openclaw-trufflehog-install-");
    const binDir = join(root, "bin");
    const downloadMarker = join(root, "downloaded");
    mkdirSync(binDir);
    const trufflehog = join(binDir, "trufflehog");
    writeFileSync(trufflehog, "#!/bin/sh\nprintf 'trufflehog 3.95.9\\n'\n");
    chmodSync(trufflehog, 0o755);
    const fakeCurl = join(binDir, "curl");
    writeFileSync(
      fakeCurl,
      `#!/bin/sh\nprintf downloaded >${JSON.stringify(downloadMarker)}\nexit 99\n`,
    );
    chmodSync(fakeCurl, 0o755);
    const fakeUname = join(binDir, "uname");
    writeFileSync(
      fakeUname,
      '#!/bin/sh\nif [ "$1" = "-s" ]; then printf "Linux\\n"; else printf "x86_64\\n"; fi\n',
    );
    chmodSync(fakeUname, 0o755);

    runBash(`source ${SCRIPT}\ninstall_trufflehog`, {
      OPENCLAW_TRUFFLEHOG_BIN_DIR: binDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(existsSync(downloadMarker)).toBe(false);
    expect(readFileSync(trufflehog, "utf8")).toContain("3.95.9");
  });

  it("creates a missing user-writable install directory without sudo", () => {
    const root = makeTempDir(tempDirs, "openclaw-trufflehog-user-bin-");
    const binDir = join(root, "nested", "bin");
    const fakeBin = join(root, "fake-bin");
    const sudoMarker = join(root, "sudo-used");
    mkdirSync(fakeBin);
    const fakeSudo = join(fakeBin, "sudo");
    writeFileSync(fakeSudo, `#!/bin/sh\nprintf used >${JSON.stringify(sudoMarker)}\nexit 99\n`);
    chmodSync(fakeSudo, 0o755);

    runBash(`source ${SCRIPT}\nrun_as_root mkdir -p "$OPENCLAW_TRUFFLEHOG_BIN_DIR"`, {
      OPENCLAW_TRUFFLEHOG_BIN_DIR: binDir,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });

    expect(existsSync(binDir)).toBe(true);
    expect(existsSync(sudoMarker)).toBe(false);
  });

  it("does not change permissions on an existing writable install directory", () => {
    const root = makeTempDir(tempDirs, "openclaw-trufflehog-existing-bin-");
    const binDir = join(root, "bin");
    const fakeBin = join(root, "fake-bin");
    const installMarker = join(root, "install-used");
    mkdirSync(binDir);
    mkdirSync(fakeBin);
    const fakeInstall = join(fakeBin, "install");
    writeFileSync(
      fakeInstall,
      `#!/bin/sh\nprintf used >${JSON.stringify(installMarker)}\nexit 99\n`,
    );
    chmodSync(fakeInstall, 0o755);

    runBash(`source ${SCRIPT}\nensure_trufflehog_bin_dir`, {
      OPENCLAW_TRUFFLEHOG_BIN_DIR: binDir,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    });

    expect(existsSync(installMarker)).toBe(false);
  });

  it("verifies the archive before extraction and replaces the binary atomically", () => {
    const script = readFileSync(SCRIPT, "utf8");
    expect(script).toContain('"$binary" --no-update --version');
    const download = script.indexOf('curl -fsSL --retry 3 --output "$tmp_dir/$archive" "$url"');
    const verify = script.indexOf("sha256sum -c -");
    const extract = script.indexOf(
      'tar --no-same-owner -xzf "$tmp_dir/$archive" -C "$tmp_dir" trufflehog',
    );
    const validate = script.indexOf('trufflehog_binary_ready "$candidate"');
    const replace = script.indexOf('mv -f "$candidate" "$target"');

    expect(download).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(download);
    expect(extract).toBeGreaterThan(verify);
    expect(validate).toBeGreaterThan(extract);
    expect(replace).toBeGreaterThan(validate);
  });
});

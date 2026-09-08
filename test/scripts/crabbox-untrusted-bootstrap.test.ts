// Crabbox untrusted bootstrap tests cover the pre-execution identity boundary.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const source = readFileSync("scripts/crabbox-untrusted-bootstrap.sh", "utf8");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function executable(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function fixture(scriptSource = source) {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-image-"));
  roots.push(root);
  const bin = join(root, "bin");
  const image = join(root, "image");
  const origin = join(root, "origin");
  const install = join(root, "install");
  const corepack = join(root, "corepack");
  const stage = join(root, "stage");
  for (const directory of [bin, image, origin, stage]) {
    mkdirSync(directory);
  }
  const nodeStage = join(stage, "node");
  mkdirSync(join(nodeStage, "bin"), { recursive: true });
  executable(
    join(nodeStage, "bin", "node"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
  );
  executable(
    join(nodeStage, "bin", "corepack"),
    `#!/bin/bash
set -eu
case "$1" in
  enable)
    ln -s corepack "$3/pnpm"
    ln -s corepack "$3/pnpx"
    ;;
  prepare)
    version="\${2#pnpm@}"
    version="\${version%%+*}"
    if [[ ! -f "$COREPACK_HOME/v1/pnpm/$version/.corepack" ]]; then
      echo pnpm-download >> ${JSON.stringify(join(root, "downloads"))}
    fi
    ;;
  install)
    [[ "$2" == "--frozen-lockfile" ]]
    echo frozen >> ${JSON.stringify(join(root, "install-log"))}
    ;;
  *) ;;
esac
`,
  );
  const wrapper = join(stage, "wrapper");
  const native = join(stage, "native");
  mkdirSync(wrapper);
  mkdirSync(native);
  writeFileSync(join(wrapper, "package.json"), '{"version":"12.3.4"}');
  executable(join(native, "pnpm"), "#!/bin/sh\necho 12.3.4\n");
  function archive(directory: string, name: string, algorithm: string) {
    const output = join(origin, name);
    execFileSync("tar", [name.endsWith(".xz") ? "-cJf" : "-czf", output, "-C", stage, directory]);
    const bytes = readFileSync(output);
    writeFileSync(join(image, name), bytes);
    return createHash(algorithm).update(bytes).digest("hex");
  }
  const hashes = {
    node: archive("node", "node-v24.19.0-linux-x64.tar.xz", "sha256"),
    wrapper: archive("wrapper", "pnpm-12.3.4.tgz", "sha512"),
    native: archive("native", "exe.linux-x64-12.3.4.tgz", "sha512"),
  };
  const productionSpec = scriptSource.match(/^pnpm_spec="([^"]+)"$/mu)?.[1] ?? "";
  const spec = `${productionSpec.split("+")[0]}+sha512.${hashes.wrapper}`;
  writeFileSync(join(root, "package.json"), JSON.stringify({ packageManager: spec }));
  executable(
    join(bin, "curl"),
    `#!/bin/bash
set -eu
case "$*" in
  *latest/api/token*) echo fixture-token; exit ;;
  *security-credentials/*) echo "\${FIXTURE_IAM_STATUS:-404}"; exit ;;
esac
echo node-download >> ${JSON.stringify(join(root, "downloads"))}
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then output="$2"; shift; fi
  url="$1"
  shift
done
if [[ "$url" == */SHASUMS256.txt ]]; then
  printf '%s  %s\\n' ${JSON.stringify(hashes.node)} node-v24.19.0-linux-x64.tar.xz > "$output"
else
  cp ${JSON.stringify(join(origin, "node-v24.19.0-linux-x64.tar.xz"))} "$output"
fi
`,
  );
  executable(join(bin, "git"), "#!/bin/sh\necho aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  executable(join(bin, "uname"), "#!/bin/sh\necho x86_64\n");
  executable(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n');
  for (const algorithm of [256, 512]) {
    executable(join(bin, `sha${algorithm}sum`), `#!/bin/sh\nexec shasum -a ${algorithm} "$@"\n`);
  }
  let script = scriptSource
    .replaceAll("/usr/bin/curl", join(bin, "curl"))
    .replaceAll("/usr/bin/git", join(bin, "git"))
    .replaceAll("/usr/bin/uname", join(bin, "uname"))
    .replaceAll("/usr/bin/sha", join(bin, "sha"))
    .replaceAll("/usr/bin/mkdir", "/bin/mkdir")
    .replaceAll("/usr/bin/ln", "/bin/ln")
    .replaceAll("/usr/local/bin", bin)
    .replaceAll("sudo ", `${JSON.stringify(join(bin, "sudo"))} `)
    .replace(
      'install_root="/opt/openclaw-untrusted-node-v${node_version}-${node_arch}"',
      `install_root="${install}"`,
    )
    .replaceAll("/opt/openclaw-untrusted-corepack", corepack)
    .replaceAll("/opt/crabbox/toolchain-archives", image);
  // Only the trusted fixture's anchors change; candidate/image state never supplies them.
  script = script
    .replace(productionSpec, spec)
    .replaceAll("14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647", hashes.node)
    .replaceAll(
      "d99a8e9523e47f05f5879711f853e259ff3e17eda1653ff74ef8542b9b22807ab06900888aaf11ec21b186774ab3adc9b5c2e2d9ad50a68fb05ff128c9f8f225",
      hashes.native,
    );
  const scriptPath = join(root, "bootstrap.sh");
  writeFileSync(scriptPath, script);
  return {
    root,
    image,
    origin,
    install,
    corepack,
    spec,
    run(extraEnv: NodeJS.ProcessEnv = {}, head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
      return spawnSync(
        "bash",
        [scriptPath, head, "/bin/sh", "-c", `echo ran >> ${JSON.stringify(join(root, "ran"))}`],
        { cwd: root, encoding: "utf8", env: { ...process.env, ...extraEnv } },
      );
    },
    downloads() {
      return existsSync(join(root, "downloads"))
        ? readFileSync(join(root, "downloads"), "utf8")
        : "";
    },
  };
}

describe("scripts/crabbox-untrusted-bootstrap.sh", () => {
  it("pins the package manager required by the trusted checkout", () => {
    const script = readFileSync("scripts/crabbox-untrusted-bootstrap.sh", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      packageManager?: string;
    };
    const pnpmSpec = script.match(/^pnpm_spec="([^"]+)"$/mu)?.[1];

    expect(pnpmSpec).toBe(packageJson.packageManager);
    const warmup = script.indexOf('"$install_root/bin/corepack" "$pnpm_spec" --version');
    expect(warmup).toBeGreaterThan(script.indexOf('cd "$install_root"'));
    expect(warmup).toBeLessThan(script.indexOf("actual_package_manager="));
  });

  it("bounds both IMDSv2 identity requests", () => {
    const script = readFileSync("scripts/crabbox-untrusted-bootstrap.sh", "utf8");
    const imdsRequests = script.match(
      /\/usr\/bin\/curl[\s\S]*?http:\/\/169\.254\.169\.254[^\n]*/gu,
    );

    expect(imdsRequests).toHaveLength(2);
    for (const request of imdsRequests ?? []) {
      expect(request).toContain("--connect-timeout 2");
      expect(request).toContain("--max-time 5");
    }
  });

  it("reuses authenticated archives without trusting a previously extracted runtime", () => {
    const f = fixture();
    for (let run = 0; run < 2; run++) {
      mkdirSync(join(f.install, "bin"), { recursive: true });
      executable(join(f.install, "bin", "node"), "#!/bin/sh\nexit 91\n");
      mkdirSync(join(f.corepack, "v1", "pnpm", "12.3.4"), { recursive: true });
      writeFileSync(join(f.corepack, "v1", "pnpm", "12.3.4", ".corepack"), '{"bin":"bad"}');
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
    }
    expect(f.downloads()).toBe("");
    expect(readFileSync(join(f.root, "install-log"), "utf8")).toBe("frozen\nfrozen\n");
    expect(readFileSync(join(f.root, "ran"), "utf8")).toBe("ran\nran\n");
  });

  it.each(["node", "wrapper", "native", "wrong-arch"])(
    "rejects a %s cache substitution despite forged adjacent metadata",
    (kind) => {
      const f = fixture();
      const archive =
        kind === "node" || kind === "wrong-arch"
          ? "node-v24.19.0-linux-x64.tar.xz"
          : kind === "wrapper"
            ? "pnpm-12.3.4.tgz"
            : "exe.linux-x64-12.3.4.tgz";
      const bytes =
        kind === "wrong-arch"
          ? readFileSync(join(f.origin, "exe.linux-x64-12.3.4.tgz"))
          : Buffer.from("substituted archive");
      writeFileSync(join(f.image, archive), bytes);
      writeFileSync(
        join(f.image, "SHASUMS256.txt"),
        `${createHash("sha256").update(bytes).digest("hex")}  ${archive}\n`,
      );
      writeFileSync(join(f.image, ".complete"), "");
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(f.downloads()).toContain(
        kind === "node" || kind === "wrong-arch" ? "node-download" : "pnpm-download",
      );
    },
  );

  it.each(["candidate-pin", "head", "iam"])("rejects %s before workload execution", (kind) => {
    const f = fixture();
    if (kind === "candidate-pin") {
      writeFileSync(join(f.root, "package.json"), '{"packageManager":"pnpm@99.0.0"}');
    }
    const result = f.run(
      kind === "iam" ? { FIXTURE_IAM_STATUS: "200" } : {},
      kind === "head" ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" : undefined,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      kind === "candidate-pin"
        ? "packageManager pin differs from trusted main"
        : kind === "head"
          ? "expected HEAD"
          : "IAM credentials endpoint returned 200",
    );
    expect(existsSync(join(f.root, "ran"))).toBe(false);
    expect(existsSync(join(f.root, "install-log"))).toBe(false);
  });

  it.each([false, true])(
    "falls back after a trusted pin advance (renamed stale archives: %s)",
    (renamed) => {
      const f = fixture(source.replace("pnpm@12.3.4+", "pnpm@12.3.5+"));
      if (renamed) {
        for (const name of ["pnpm-12.3.4.tgz", "exe.linux-x64-12.3.4.tgz"]) {
          writeFileSync(
            join(f.image, name.replace("12.3.4", "12.3.5")),
            readFileSync(join(f.image, name)),
          );
        }
      }
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(f.downloads()).toBe("pnpm-download\n");
      expect(readFileSync(join(f.root, "install-log"), "utf8")).toBe("frozen\n");
    },
  );

  it("refuses an invalid download after rejecting the image archive", () => {
    const f = fixture();
    for (const directory of [f.image, f.origin]) {
      writeFileSync(join(directory, "node-v24.19.0-linux-x64.tar.xz"), "invalid");
    }
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("differs from the trusted digest");
    expect(existsSync(f.install)).toBe(false);
    expect(existsSync(join(f.root, "ran"))).toBe(false);
  });

  it("clears Node injection before reading the candidate package manager", () => {
    const f = fixture();
    const injected = join(f.root, "injected.cjs");
    writeFileSync(injected, 'throw new Error("injected Node options executed");');
    const result = f.run({ NODE_OPTIONS: `--require=${injected}`, NODE_PATH: f.root });
    expect(result.status, result.stderr).toBe(0);
  });
});

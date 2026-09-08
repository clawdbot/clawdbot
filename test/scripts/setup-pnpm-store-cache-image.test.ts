import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const source = readFileSync(
  ".github/actions/setup-pnpm-store-cache/seed-pnpm-from-image.mjs",
  "utf8",
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pnpm-image-"));
  roots.push(root);
  const image = join(root, "image");
  const runnerTemp = join(root, "runner");
  const stage = join(root, "stage");
  for (const directory of [image, runnerTemp, stage]) {
    mkdirSync(directory);
  }
  function archive(name: string) {
    writeFileSync(join(stage, "pnpm"), name);
    execFileSync("tar", ["-czf", join(image, name), "-C", root, "stage"]);
    return createHash("sha512")
      .update(readFileSync(join(image, name)))
      .digest("hex");
  }
  const wrapperHash = archive("pnpm-12.3.4.tgz");
  const nativeHash = archive("exe.linux-x64-12.3.4.tgz");
  // The fixture is a trusted script with synthetic anchors, not a candidate-supplied pin.
  const script = source
    .replaceAll("/opt/crabbox/toolchain-archives", image)
    .replaceAll("process.platform", '"linux"')
    .replaceAll("process.arch", '"x64"')
    .replace(
      "961aa41fb077da3a04a441d9f8e15ebc0c96da8ef710b2eb67bf9ee7cb0610eabd48f1fd85f51cffe73846785fa0f87c56a3a872a1d893f8446741b5cce45457",
      wrapperHash,
    )
    .replace(
      "d99a8e9523e47f05f5879711f853e259ff3e17eda1653ff74ef8542b9b22807ab06900888aaf11ec21b186774ab3adc9b5c2e2d9ad50a68fb05ff128c9f8f225",
      nativeHash,
    );
  const scriptPath = join(root, "seed.mjs");
  writeFileSync(scriptPath, script);
  const spec = `pnpm@12.3.4+sha512.${wrapperHash}`;
  return {
    root,
    image,
    runnerTemp,
    spec,
    run(packageManager = spec) {
      return spawnSync(process.execPath, [scriptPath, packageManager], {
        encoding: "utf8",
        env: { ...process.env, RUNNER_TEMP: runnerTemp, COREPACK_HOME: join(root, "old-corepack") },
      });
    },
  };
}

describe("pnpm image archive consumer", () => {
  it("seeds each job from verified archives into independent private Corepack state", () => {
    const f = fixture();
    const homes: string[] = [];
    for (let run = 0; run < 2; run++) {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      const home = result.stdout.trim();
      homes.push(home);
      const pnpmRoot = join(home, "v1", "pnpm", "12.3.4");
      expect(readFileSync(join(pnpmRoot, "pnpm"), "utf8")).toBe("pnpm-12.3.4.tgz");
      expect(
        readFileSync(join(pnpmRoot, "node_modules", "@pnpm", "exe.linux-x64", "pnpm"), "utf8"),
      ).toBe("exe.linux-x64-12.3.4.tgz");
      const metadata = JSON.parse(readFileSync(join(pnpmRoot, ".corepack"), "utf8"));
      expect(metadata.hash).toBe(f.spec.slice(f.spec.indexOf("+") + 1));
      expect(metadata.bin.pnpm).toBe("./bin/pnpm.mjs");
      writeFileSync(join(pnpmRoot, "pnpm"), "tampered extracted executable");
    }
    expect(homes[0]).not.toBe(homes[1]);
    expect(existsSync(join(f.root, "old-corepack"))).toBe(false);
    expect(readdirSync(f.runnerTemp)).toHaveLength(2);
  });

  it.each(["pnpm-12.3.4.tgz", "exe.linux-x64-12.3.4.tgz"])(
    "refuses substituted %s without accepting adjacent hash or completion files",
    (name) => {
      const f = fixture();
      writeFileSync(join(f.image, name), "bad archive");
      writeFileSync(join(f.image, ".complete"), "");
      writeFileSync(
        join(f.image, `${name}.sha512`),
        createHash("sha512").update("bad archive").digest("hex"),
      );
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(readdirSync(f.runnerTemp)).toEqual([]);
    },
  );

  it.each(["missing", "different-version", "different-hash"])(
    "leaves ordinary Corepack preparation in control on %s",
    (kind) => {
      const f = fixture();
      if (kind === "missing") {
        rmSync(join(f.image, "pnpm-12.3.4.tgz"));
      }
      const spec =
        kind === "different-version"
          ? f.spec.replace("12.3.4", "12.3.5")
          : kind === "different-hash"
            ? f.spec.replace(/.$/u, "z")
            : f.spec;
      const result = f.run(spec);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(readdirSync(f.runnerTemp)).toEqual([]);
    },
  );

  it("wires image seeding before preparation without changing dependency installation", () => {
    const action = parse(readFileSync(".github/actions/setup-pnpm-store-cache/action.yml", "utf8"));
    const workflow = parse(readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8"));
    for (const steps of [action.runs.steps, workflow.jobs.hydrate.steps]) {
      const preparation = steps.find((step: { run?: string }) =>
        step.run?.includes("corepack prepare"),
      );
      expect(preparation.run.indexOf("seed-pnpm-from-image.mjs")).toBeLessThan(
        preparation.run.indexOf("corepack prepare"),
      );
      expect(preparation.run).toContain('echo "COREPACK_HOME=$COREPACK_HOME" >> "$GITHUB_ENV"');
    }
    const hydration = workflow.jobs.hydrate.steps;
    expect(hydration.find((step: { name: string }) => step.name === "Setup Node.js").run).toContain(
      'openclaw_ensure_node "24.x"',
    );
    expect(
      hydration.find((step: { run?: string }) => step.run?.includes("install_args=")).run,
    ).toContain("--frozen-lockfile");
  });

  it.each([
    ["hydrate", true],
    ["hydrate", false],
    ["hydrate-github", true],
    ["hydrate-github", false],
  ] as const)("restores %s Corepack state in a fresh shell (configured=%s)", (job, configured) => {
    const workflow = parse(readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8"));
    const ready = workflow.jobs[job].steps.find(
      (step: { name?: string }) => step.name === "Mark Crabbox ready",
    );
    const home = mkdtempSync(join(tmpdir(), "crabbox-session-"));
    roots.push(home);
    const corepackHome = join(
      home,
      "corepack cache ' \" $HOME $(touch injected) `touch injected` ;",
    );
    mkdirSync(corepackHome);
    writeFileSync(join(corepackHome, "ready.txt"), "prepared cache fixture\n");
    const env = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      CRABBOX_ID: "image-cache",
      CRABBOX_JOB: job,
      GITHUB_WORKSPACE: home,
      GITHUB_RUN_ID: "123",
    };
    const marked = spawnSync(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", `docker() { :; }\n${ready.run}`],
      {
        cwd: home,
        encoding: "utf8",
        env: { ...env, ...(configured ? { COREPACK_HOME: corepackHome } : {}) },
      },
    );
    expect(marked.status, marked.stderr).toBe(0);
    const restored = spawnSync(
      "/bin/bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        `set -euo pipefail
source "$1"
if [ "\${COREPACK_HOME+x}" = x ]; then
  printf '%s\\n' "$COREPACK_HOME"
  cat "$COREPACK_HOME/ready.txt"
else
  printf 'unset\\n'
fi`,
        "saved-session",
        join(home, ".crabbox", "actions", "image-cache.env.sh"),
      ],
      { cwd: home, encoding: "utf8", env },
    );
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toBe(
      configured ? `${corepackHome}\nprepared cache fixture\n` : "unset\n",
    );
    expect(existsSync(join(home, "injected"))).toBe(false);
  });
});

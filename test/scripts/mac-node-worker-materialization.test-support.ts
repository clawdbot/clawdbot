import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { chmod, cp, link, mkdir, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect } from "vitest";
import { artifactFixture, write } from "./mac-elevation-artifact.test-support.js";
import {
  compiledMacNativeFixtures,
  macFatContainerFixture,
  macObjectFixture,
  runMacFixtureTool,
} from "./mac-native-fixtures.test-support.js";
import { createMacScriptTest, type MacScriptFixture } from "./mac-script-fixture.test-support.js";
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const materializer = "scripts/materialize-mac-node-worker.py";
const inventory = "scripts/lib/mac-native-inventory.py";

type WorkerScratchObservation = {
  phase: "pack" | "install" | "verify";
  home: string;
  temporary: string;
  createdDirectory: string;
  privateRoot: string | null;
  privateRootMode: number | null;
  product: string;
  productDevice: string;
  productInode: string;
};

function snapshot(root: string) {
  const records: { path: string; mode: number; kind: string; content?: string }[] = [];
  function visit(file: string) {
    const stat = lstatSync(file);
    const kind = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "link" : "file";
    records.push({
      path: path.relative(root, file),
      mode: stat.mode & 0o7777,
      kind,
      ...(kind === "link"
        ? { content: readlinkSync(file) }
        : kind === "file"
          ? { content: createHash("sha256").update(readFileSync(file)).digest("hex") }
          : {}),
    });
    if (kind === "directory") {
      for (const name of readdirSync(file).toSorted()) {
        visit(path.join(file, name));
      }
    }
  }
  visit(root);
  return records;
}

async function materializationFixture(mac: MacScriptFixture, complete = false) {
  const root = realpathSync(mac.createTempDir("openclaw-worker-native-copy-"));
  const source = path.join(root, "canonical");
  const parent = path.join(root, "stage");
  const destination = path.join(parent, "derived");
  await mkdir(source);
  await mkdir(parent);
  const binaries = await compiledMacNativeFixtures(root, mac);
  for (const [name, bytes] of Object.entries(
    complete ? binaries : { arm64: binaries.arm64, elf: binaries.elf },
  )) {
    await write(path.join(source, `images/${name}`), bytes);
  }
  for (const filename of [
    "nested/win32/README.md",
    "nested/win32/build.mjs",
    "nested/win32/src/modifiers.c",
    "opposite-linux/name.node",
    "space [*]?\nresource.js",
  ]) {
    await write(
      path.join(source, filename),
      "// nonbinary resource remains byte-identical\n",
      0o640,
    );
  }
  await write(path.join(source, "engine.wasm"), Buffer.from("0061736d01000000", "hex"));
  // Java and fat Mach-O share CAFEBABE. Classifier-owned non-native resources survive.
  await write(
    path.join(source, "Example.class"),
    Buffer.from("cafebabe0000003400010001000000000000000000000000", "hex"),
  );
  for (let i = 0; i < (complete ? 70 : 2); i++) {
    await write(path.join(source, `scripts/${i} [*]\n.js`), `// resource ${i}\n`);
  }
  await mkdir(path.join(source, "empty"));
  await chmod(path.join(source, "empty"), 0o550);
  await symlink("../nested/win32/build.mjs", path.join(source, "scripts/npm-style"));
  await symlink("nested/win32", path.join(source, "directory-alias"));
  return {
    root,
    source,
    parent,
    destination,
    binaries,
    async run(
      arch = "arm64",
      options: { source?: string; destination?: string; prelude?: string } = {},
    ) {
      return await mac.run(
        "/usr/bin/python3",
        [
          "-B",
          ...(options.prelude
            ? [
                "-c",
                `${options.prelude}\nimport runpy, sys\nsys.argv = sys.argv[1:]\nrunpy.run_path(sys.argv[0], run_name="__main__")`,
              ]
            : []),
          materializer,
          options.source ?? source,
          options.destination ?? destination,
          parent,
          arch,
        ],
        {
          encoding: "utf8",
          env: { HOME: root, TMPDIR: root, PATH: systemPath },
        },
      );
    },
  };
}

async function stagingFixture(mac: MacScriptFixture) {
  const root = realpathSync(mac.createTempDir("openclaw-worker-materialization-"));
  const binaries = await compiledMacNativeFixtures(root, mac);
  const scripts = path.join(root, "scripts");
  const destination = path.join(root, "published");
  const calls = path.join(root, "verification-calls");
  const scratchLog = path.join(root, "scratch-observations");
  const tmp = path.join(root, "tmp");
  await mkdir(scripts);
  await mkdir(tmp);
  await write(path.join(root, "operator-sentinel"), "ambient home must remain untouched");
  await write(path.join(tmp, "other-task/sentinel"), "unrelated scratch must survive");
  await cp("scripts/stage-mac-node-worker.sh", path.join(scripts, "stage-mac-node-worker.sh"));
  await cp(materializer, path.join(scripts, path.basename(materializer)));
  await write(path.join(scripts, "lib/mac-native-inventory.py"), readFileSync(inventory));
  await write(path.join(root, "dist/build-info.json"), '{"buildId":"unchanged-build"}');
  await write(
    path.join(scripts, "record-scratch.cjs"),
    `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
module.exports = (phase, product) => {
  const home = fs.realpathSync(process.env.HOME);
  assert(fs.statSync(home).isDirectory(), 'child HOME must already exist');
  assert(!fs.existsSync(path.join(home, 'operator-sentinel')), 'ambient HOME leaked');
  assert.equal(process.env.OPENCLAW_STATE_DIR, undefined, 'ambient state leaked');
  const temporary = fs.realpathSync(os.tmpdir());
  const component = path.relative(${JSON.stringify(tmp)}, temporary).split(path.sep)[0];
  const privateRoot = component && component !== '..' ? path.join(${JSON.stringify(tmp)}, component) : null;
  const createdDirectory = fs.mkdtempSync(path.join(temporary, 'fixture-scratch-'));
  fs.writeFileSync(path.join(createdDirectory, 'sentinel'), phase);
  fs.mkdirSync(path.join(home, '.npm'), { recursive: true });
  fs.writeFileSync(path.join(home, '.npm/cache'), phase);
  const info = fs.statSync(product, { bigint: true });
  fs.appendFileSync(${JSON.stringify(scratchLog)}, JSON.stringify({
    phase, home, temporary, createdDirectory, privateRoot,
    privateRootMode: privateRoot === null ? null : fs.statSync(privateRoot).mode & 0o777,
    product, productDevice: info.dev.toString(), productInode: info.ino.toString(),
  }) + '\\n');
};
if (require.main === module) module.exports(process.argv[2], process.argv[3]);
`,
  );
  await write(
    path.join(scripts, "package-openclaw-for-docker.mjs"),
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import recordScratch from './record-scratch.cjs';
assert(process.argv.includes('--pnpm-pack'), 'worker package must use the repository-pinned packer');
const target = path.join(process.argv[process.argv.indexOf('--output-dir') + 1], process.argv[process.argv.indexOf('--output-name') + 1]);
fs.writeFileSync(target, 'inert package mock');
recordScratch('pack', target);
if (fs.existsSync(${JSON.stringify(path.join(root, "reject-pack"))})) process.exit(41);
console.log(target);
`,
  );
  await write(
    path.join(scripts, "verify-mac-node-worker.mjs"),
    `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import recordScratch from './record-scratch.cjs';
assert.equal(process.argv[3], ${JSON.stringify(path.join(root, "dist/build-info.json"))});
assert.equal(fs.readFileSync(process.argv[2]+'/build-info.json', 'utf8'), fs.readFileSync(process.argv[3], 'utf8'));
recordScratch('verify', process.argv[2]);
if (process.argv[2].includes('/x86_64/') && fs.existsSync(${JSON.stringify(path.join(root, "reject-verification"))})) process.exit(42);
`,
  );
  for (const arch of ["arm64", "x86_64"] as const) {
    const canonical = path.join(root, "canonical", arch);
    await write(path.join(canonical, "matching.node"), binaries[arch]);
    await write(path.join(canonical, "foreign.node"), binaries.elf);
    await write(
      path.join(canonical, "nested/win32/build.mjs"),
      "// preserve Windows source\n",
      0o755,
    );
    await cp(path.join(root, "dist/build-info.json"), path.join(canonical, "build-info.json"));
    // The fixture Node is an explicit execution mock; no native payload is launched.
    await write(
      path.join(canonical, "bin/node"),
      `#!/bin/bash
set -euo pipefail
if [[ "$1" == -e ]]; then exit 0; fi
[[ "$1" == ${quote(path.join(scripts, "verify-mac-node-worker.mjs"))} ]] || exit 97
printf '%s|%s|%s\\n' "$0" "$2" "$3" >> ${quote(calls)}
exec ${quote(process.execPath)} "$@"
`,
      0o755,
    );
  }
  await write(
    path.join(scripts, "install-cli.sh"),
    `
[[ -d "$HOME" ]] || { echo "fixture installer HOME must exist before source" >&2; exit 96; }
node_dir() { printf '%s' "$PREFIX/node"; }
node_bin() { printf '%s/bin/node' "$(node_dir)"; }
install_node() {
  local selected="$2"
  [[ "$selected" != x64 ]] || selected=x86_64
  mkdir -p "$PREFIX"
  # This mock installs the canonical payload without applying the caller's umask.
  cp -pR ${quote(path.join(root, "canonical"))}/"$selected" "$(node_dir)"
  ${quote(process.execPath)} ${quote(path.join(scripts, "record-scratch.cjs"))} install "$PREFIX"
}
install_openclaw() { [[ "$(cat "$OPENCLAW_VERSION")" == "inert package mock" ]]; }
`,
  );
  return {
    root,
    destination,
    calls,
    scratchLog,
    tmp,
    temporaryBefore: snapshot(tmp),
    readScratchObservations(): WorkerScratchObservation[] {
      return existsSync(scratchLog)
        ? readFileSync(scratchLog, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as WorkerScratchObservation)
        : [];
    },
    async run(variant: string, tempRoot = tmp) {
      return await mac.run(
        "/bin/bash",
        [path.join(scripts, "stage-mac-node-worker.sh"), destination, "arm64", "x86_64"],
        {
          encoding: "utf8",
          env: {
            HOME: root,
            TMPDIR: tempRoot,
            OPENCLAW_STATE_DIR: path.join(root, "operator-state"),
            PATH: `${path.dirname(process.execPath)}:${systemPath}`,
            OPENCLAW_MAC_SIGNING_VARIANT: variant,
          },
        },
      );
    },
  };
}

function expectWorkerScratchCleaned(fixture: Awaited<ReturnType<typeof stagingFixture>>) {
  for (const observation of fixture.readScratchObservations()) {
    expect(existsSync(observation.home)).toBe(false);
    expect(existsSync(observation.createdDirectory)).toBe(false);
  }
  expect(snapshot(fixture.tmp)).toEqual(fixture.temporaryBefore);
}

export function registerMacWorkerMaterializationTests() {
  describe.skipIf(process.platform !== "darwin")("elevation worker materialization", () => {
    const it = createMacScriptTest();
    it.for(["standard", "elevation-host"])(
      "keeps %s worker scratch in caller temp and publishes runtimes by same-volume moves",
      (variant, { mac }) =>
        mac.lifetime.run(async () => {
          const fixture = await stagingFixture(mac);
          const before = snapshot(path.join(fixture.root, "canonical"));
          const result = await fixture.run(variant);
          expect(result.status, result.stderr).toBe(0);
          expect(snapshot(path.join(fixture.root, "canonical"))).toEqual(before);
          const observations = fixture.readScratchObservations();
          expect(observations.map(({ phase }) => phase)).toEqual([
            "pack",
            "install",
            "verify",
            "install",
            "verify",
          ]);
          expect(new Set(observations.map(({ privateRoot }) => privateRoot)).size).toBe(1);
          for (const observation of observations) {
            expect(observation.privateRoot).not.toBeNull();
            expect(path.dirname(observation.privateRoot!)).toBe(fixture.tmp);
            expect(observation.privateRootMode).toBe(0o700);
            for (const file of [observation.home, observation.temporary]) {
              expect(path.relative(observation.privateRoot!, file).split(path.sep)[0]).not.toBe(
                "..",
              );
            }
            expect(observation.createdDirectory.startsWith(`${observation.temporary}/`)).toBe(true);
            if (observation.phase === "pack") {
              expect(observation.product.startsWith(`${observation.privateRoot}/`)).toBe(true);
            } else {
              expect(observation.product.startsWith(`${fixture.tmp}/`)).toBe(false);
              expect(observation.productDevice).toBe(
                statSync(path.dirname(fixture.destination), { bigint: true }).dev.toString(),
              );
            }
          }
          const calls = readFileSync(fixture.calls, "utf8").trim().split("\n");
          expect(calls).toHaveLength(2);
          for (const [index, call] of calls.entries()) {
            const arch = index === 0 ? "arm64" : "x86_64";
            const [node, runtime, expected] = call.split("|");
            expect(node).toBe(`${runtime}/bin/node`);
            expect(runtime).toContain(
              `/${arch}/${variant === "standard" ? "runtime" : "elevation"}`,
            );
            expect(expected).toBe(path.join(fixture.root, "dist/build-info.json"));
            const scratch = path.resolve(runtime!, "../..");
            expect(path.dirname(scratch)).toBe(path.dirname(fixture.destination));
            expect(existsSync(scratch)).toBe(false);
            const verified = observations.find(
              ({ phase, product }) => phase === "verify" && product === runtime,
            );
            expect(verified).toBeDefined();
            expect(
              statSync(path.join(fixture.destination, arch), { bigint: true }).ino.toString(),
            ).toBe(verified!.productInode);
            expect(snapshot(path.join(fixture.destination, arch))).toEqual(
              snapshot(path.join(fixture.root, "canonical", arch)).filter(
                (entry) => variant === "standard" || entry.path !== "foreign.node",
              ),
            );
          }
          expectWorkerScratchCleaned(fixture);
        }),
    );

    it.for(["standard", "elevation-host"])(
      "rejects unavailable worker scratch before %s publication",
      (variant, { mac }) =>
        mac.lifetime.run(async () => {
          const fixture = await stagingFixture(mac);
          const before = snapshot(fixture.root);
          const result = await fixture.run(variant, path.join(fixture.tmp, "unavailable"));
          expect(result.status, result.stderr).not.toBe(0);
          expect(fixture.readScratchObservations()).toEqual([]);
          expect(existsSync(fixture.calls)).toBe(false);
          expect(snapshot(fixture.root)).toEqual(before);
        }),
    );

    it.for(["standard", "elevation-host"])(
      "cleans worker scratch and product staging after %s pack failure",
      (variant, { mac }) =>
        mac.lifetime.run(async () => {
          const fixture = await stagingFixture(mac);
          await write(path.join(fixture.root, "reject-pack"), "");
          const before = readdirSync(fixture.root).toSorted();
          const result = await fixture.run(variant);
          expect(result.status, result.stderr).toBe(41);
          expect(fixture.readScratchObservations().map(({ phase }) => phase)).toEqual(["pack"]);
          expect(existsSync(fixture.calls)).toBe(false);
          expect(existsSync(fixture.destination)).toBe(false);
          expectWorkerScratchCleaned(fixture);
          expect(
            readdirSync(fixture.root)
              .filter((name) => name !== path.basename(fixture.scratchLog))
              .toSorted(),
          ).toEqual(before);
        }),
    );

    it.for(
      ["standard", "elevation-host"].flatMap((variant) =>
        ["verification", "occupied", "occupied-link"].map((failure) => ({ variant, failure })),
      ),
    )(
      "publishes neither architecture on second $variant $failure failure",
      ({ variant, failure }, { mac }) =>
        mac.lifetime.run(async () => {
          const fixture = await stagingFixture(mac);
          if (failure === "verification") {
            await write(path.join(fixture.root, "reject-verification"), "");
          } else if (failure === "occupied") {
            await write(path.join(fixture.destination, "x86_64/sentinel"), "owner");
          } else {
            await mkdir(fixture.destination);
            await symlink("missing", path.join(fixture.destination, "x86_64"));
          }
          const before = existsSync(fixture.destination) ? snapshot(fixture.destination) : [];
          const result = await fixture.run(variant);
          expect(result.status, result.stderr).toBe(failure === "verification" ? 42 : 1);
          const calls = readFileSync(fixture.calls, "utf8").trim().split("\n");
          expect(calls).toHaveLength(2);
          for (const call of calls) {
            expect(existsSync(path.resolve(call.split("|")[1]!, "../.."))).toBe(false);
          }
          expect(existsSync(path.join(fixture.destination, "arm64"))).toBe(false);
          expect(existsSync(fixture.destination) ? snapshot(fixture.destination) : []).toEqual(
            before,
          );
          expect(fixture.readScratchObservations()).toHaveLength(5);
          expectWorkerScratchCleaned(fixture);
        }),
    );

    it.for(["arm64", "x86_64"])(
      "retains every resource and eligible native image for %s without changing canonical input",
      (arch, { mac }) =>
        mac.lifetime.run(async () => {
          const fixture = await materializationFixture(mac, true);
          for (const fat64 of [false, true]) {
            const bytes = await macFatContainerFixture(
              fixture.root,
              [
                await macObjectFixture(fixture.root, "arm64", mac),
                await macObjectFixture(fixture.root, "x86_64", mac),
              ],
              fat64,
              mac,
            );
            expect(
              (
                await runMacFixtureTool(
                  "/usr/bin/lipo",
                  ["-archs", path.join(fixture.root, "fat-container")],
                  fixture.root,
                  mac,
                )
              )
                .split(" ")
                .toSorted(),
            ).toEqual(["arm64", "x86_64"]);
            expect(bytes.readUInt32BE(0)).toBe(fat64 ? 0xcafebabf : 0xcafebabe);
            expect(bytes.readUInt32BE(4)).toBe(2);
            // Synthetic classification controls, never memory dumps or executed.
            // lipo -create ignores MH_CORE inputs; change only the completed slices' types.
            for (let index = 0; index < 2; index++) {
              const record = 8 + index * (fat64 ? 32 : 20);
              const offset = fat64
                ? Number(bytes.readBigUInt64BE(record + 8))
                : bytes.readUInt32BE(record + 8);
              expect(bytes.readUInt32LE(offset)).toBe(0xfeedfacf);
              expect(bytes.readUInt32LE(offset + 12)).toBe(1);
              bytes.writeUInt32LE(4, offset + 12);
            }
            await write(path.join(fixture.source, `synthetic-core-fat${fat64 ? 64 : 32}`), bytes);
          }
          const oddNative = "images/odd [*]?\narm64";
          await rename(
            path.join(fixture.source, "images/arm64"),
            path.join(fixture.source, oddNative),
          );
          for (const [name, contents, mode] of [
            ["database.js", "db.connect();\n", 0o644],
            ["unicode.js", "db.label = 'café';\n", 0o644],
            ["query.txt", "(Query expression)\n", 0o644],
            ["setuid.txt", "small inert resource\n", 0o4755],
          ] as const) {
            const resource = path.join(fixture.source, "scripts", name);
            await write(resource, contents, mode);
            expect(statSync(resource).mode & 0o7777).toBe(mode);
          }
          // Establish the source filesystem's actual name equivalence; never guess
          // which Unicode spelling readdir returns or fold component text in the test.
          for (const [name, literal, alias] of [
            ["Library/addon.node", "library/ADDON.NODE", "0-case-alias"],
            ["Café.txt", "Cafe\u0301.txt", "0-unicode-alias"],
          ] as const) {
            await write(path.join(fixture.source, name), "retained lookup resource\n", 0o640);
            expect(statSync(path.join(fixture.source, literal)).ino).toBe(
              statSync(path.join(fixture.source, name)).ino,
            );
            await symlink(literal, path.join(fixture.source, alias));
          }
          await link(
            path.join(fixture.source, "Library/addon.node"),
            path.join(fixture.source, "Library/second.node"),
          );
          await symlink("library/SECOND.NODE", path.join(fixture.source, "0-hardlink-alias"));
          await symlink("library/", path.join(fixture.source, "0-directory"));
          await symlink("0-DIRECTORY/../engine.wasm", path.join(fixture.source, "0-parent-alias"));
          await chmod(fixture.source, 0o750);
          const before = snapshot(fixture.source);
          const result = await fixture.run(arch);
          expect(result.status, result.stderr).toBe(0);
          const omitted = new Set(
            [
              "coff",
              "pe",
              "elf",
              ...(arch === "arm64"
                ? ["x86_64", "intelLibrary", "intelArchive"]
                : ["arm64", "armLibrary", "armArchive"]),
            ].map((name) => (name === "arm64" ? oddNative : `images/${name}`)),
          );
          expect(snapshot(fixture.destination)).toEqual(
            before.filter((entry) => !omitted.has(entry.path)),
          );
          expect(snapshot(fixture.source)).toEqual(before);
          for (const alias of [
            "0-case-alias",
            "0-unicode-alias",
            "0-hardlink-alias",
            "0-parent-alias",
          ]) {
            expect(readFileSync(path.join(fixture.destination, alias))).toEqual(
              readFileSync(path.join(fixture.source, alias)),
            );
            expect(readlinkSync(path.join(fixture.destination, alias))).toBe(
              readlinkSync(path.join(fixture.source, alias)),
            );
          }
          const outputSecond = statSync(path.join(fixture.destination, "Library/second.node"));
          expect(outputSecond.ino).not.toBe(
            statSync(path.join(fixture.destination, "Library/addon.node")).ino,
          );
          expect(statSync(path.join(fixture.destination, "0-hardlink-alias")).ino).toBe(
            outputSecond.ino,
          );
          expect(result.stderr).toContain("omitted 6 native images");
          for (const name of omitted) {
            expect(result.stderr).toContain(JSON.stringify(name));
          }
          expect(
            await runMacFixtureTool(
              "/usr/bin/lipo",
              ["-archs", path.join(fixture.destination, "images/fat64")],
              fixture.root,
              mac,
            ),
          ).toContain(arch);
        }),
    );

    it.for([
      "occupied",
      "occupied-link",
      "inside-source",
      "outside-parent",
      "source-link",
      "parent-alias",
    ])(
      "rejects unsafe construction roots (%s) without touching input or occupants",
      (kind, { mac }) =>
        mac.lifetime.run(async () => {
          const fixture = await materializationFixture(mac);
          let source = fixture.source;
          let destination = fixture.destination;
          if (kind === "occupied") {
            await write(path.join(destination, "sentinel"), "owner");
          }
          if (kind === "occupied-link") {
            await symlink(source, destination);
          }
          if (kind === "inside-source") {
            destination = path.join(source, "new-output");
          }
          if (kind === "outside-parent") {
            destination = path.join(fixture.root, "new-output");
          }
          if (kind === "source-link") {
            source = path.join(fixture.root, "source-alias");
            await symlink(fixture.source, source);
          }
          if (kind === "parent-alias") {
            await symlink(fixture.source, path.join(fixture.parent, "alias"));
            destination = path.join(fixture.parent, "alias", "new-output");
          }
          const before = snapshot(fixture.root);
          const result = await fixture.run("arm64", { source, destination });
          expect(result.status, result.stderr).not.toBe(0);
          expect(result.stderr).toMatch(/File exists|disjoint|Not a directory/);
          expect(snapshot(fixture.root)).toEqual(before);
        }),
    );

    it.for([
      "absolute",
      "escape",
      "dangling",
      "omitted",
      "case-omitted",
      "case-cycle",
      "case-file-slash",
      "link-cycle",
      "directory-cycle",
      "indirect-cycle",
    ])("rejects unprovable source links (%s) and leaves no partial output", (kind, { mac }) =>
      mac.lifetime.run(async () => {
        const fixture = await materializationFixture(mac);
        const targets: Record<string, string> = {
          absolute: path.join(fixture.source, "engine.wasm"),
          escape: "../inert.c",
          omitted: "images/elf",
          "case-omitted": "IMAGES/ELF",
          "case-cycle": "LINK",
          "case-file-slash": "IMAGES/ARM64/",
          "directory-cycle": ".",
          "link-cycle": "link",
        };
        const target = targets[kind] ?? "missing";
        if (kind === "indirect-cycle") {
          await mkdir(path.join(fixture.source, "a"));
          await mkdir(path.join(fixture.source, "b"));
          await symlink("../b", path.join(fixture.source, "a/to-b"));
          await symlink("../a", path.join(fixture.source, "b/to-a"));
        } else {
          await symlink(target, path.join(fixture.source, "link"));
        }
        const before = snapshot(fixture.source);
        const result = await fixture.run();
        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stderr).toMatch(/symlink|Cyclic|ELOOP|ENOENT|No such file/);
        expect(snapshot(fixture.source)).toEqual(before);
        expect(existsSync(fixture.destination)).toBe(false);
      }),
    );

    it.for([
      ["feedface", 18, false],
      ["cefaedfe", 7, false],
      ["feedfacf", 0x1000012, false],
      ["cffaedfe", 0x100000c, true],
      ["cafebabe", 0, true],
      ["cafebabf", 0, true],
      ["bebafeca", 0, false],
      ["bfbafeca", 0, false],
    ] as const)(
      "classifies Mach magic %s with real Darwin tools",
      ([magic, cpu, retained], { mac }) =>
        mac.lifetime.run(async () => {
          const fixture = await materializationFixture(mac);
          let bytes: Buffer;
          if (cpu) {
            const wide = magic === "feedfacf" || magic === "cffaedfe";
            bytes = Buffer.alloc(wide ? 32 : 28);
            Buffer.from(magic, "hex").copy(bytes);
            const little = magic === "cefaedfe" || magic === "cffaedfe";
            const fields = [cpu, cpu === 7 ? 3 : 0, 1, 0, 0, 0];
            fields.forEach((value, index) =>
              little
                ? bytes.writeUInt32LE(value, 4 + index * 4)
                : bytes.writeUInt32BE(value, 4 + index * 4),
            );
          } else {
            bytes = Buffer.from(
              magic === "cafebabf" || magic === "bfbafeca"
                ? fixture.binaries.fat64
                : fixture.binaries.universal,
            );
            if (magic === "bebafeca" || magic === "bfbafeca") {
              // Apple's fat.h requires big-endian on disk; swapped containers fail closed.
              const stride = magic === "bfbafeca" ? 32 : 20;
              bytes.subarray(0, 8).swap32();
              for (let index = 0; index < 2; index++) {
                const start = 8 + index * stride;
                bytes.subarray(start, start + (stride === 20 ? 20 : 8)).swap32();
                if (stride === 32) {
                  bytes.subarray(start + 8, start + 24).swap64();
                  bytes.subarray(start + 24, start + 32).swap32();
                }
              }
            }
          }
          await write(path.join(fixture.source, "magic"), bytes);
          const before = snapshot(fixture.source);
          const authority = await mac.run(
            "/usr/bin/lipo",
            ["-archs", path.join(fixture.source, "magic")],
            {
              encoding: "utf8",
              env: { HOME: fixture.root, TMPDIR: fixture.root, PATH: systemPath },
            },
          );
          const result = await fixture.run();
          // Newer Apple lipo also rejects big-endian thin headers. Its failure must
          // stop construction, never turn an unclassified native image into a resource.
          const unsupported = authority.status !== 0;
          if (unsupported) {
            expect(result.status, result.stderr).not.toBe(0);
            expect(existsSync(fixture.destination)).toBe(false);
          } else {
            expect(result.status, result.stderr).toBe(0);
            expect(existsSync(path.join(fixture.destination, "magic"))).toBe(retained);
            if (retained) {
              expect(readFileSync(path.join(fixture.destination, "magic"))).toEqual(bytes);
            }
          }
          expect(snapshot(fixture.source)).toEqual(before);
        }),
    );

    it.for(["mach", "fat64", "elf", "pe", "coff", "archive"])(
      "fails closed on malformed %s native candidates",
      (kind, { mac }) =>
        mac.lifetime.run(async () => {
          const fixture = await materializationFixture(mac);
          const bytes =
            kind === "mach"
              ? Buffer.from("cffaedfe", "hex")
              : kind === "fat64"
                ? Buffer.from("cafebabf", "hex")
                : kind === "elf"
                  ? fixture.binaries.elf.subarray(0, 7)
                  : kind === "coff"
                    ? fixture.binaries.coff.subarray(0, 3)
                    : kind === "pe"
                      ? fixture.binaries.pe.subarray(0, 16)
                      : Buffer.from("!<arch>\nmalformed");
          await write(path.join(fixture.source, "broken"), bytes);
          const before = snapshot(fixture.source);
          const result = await fixture.run();
          expect(result.status, result.stderr).not.toBe(0);
          expect(existsSync(fixture.destination)).toBe(false);
          expect(snapshot(fixture.source)).toEqual(before);
        }),
    );

    it.for([
      "file-exit",
      "file-framing",
      "file-empty",
      "file-error",
      "file-unknown",
      "lipo",
      "lipo-framing",
      "lipo-unknown",
      "lipo-fat-unknown",
      "lipo-wrong-fd",
      "lipo-fat-wrong-fd",
      "lipo-prefix",
      "lipo-multiline",
      "lipo-incomplete",
      "lipo-empty",
      "scan",
      "copy",
      "close",
      "output-link",
    ])("fails closed on %s errors without publishing partial output", (failure, { mac }) =>
      mac.lifetime.run(async () => {
        const fixture = await materializationFixture(mac);
        const before = snapshot(fixture.source);
        const result = await fixture.run("arm64", {
          prelude: `
import os, shutil, subprocess
failure = ${JSON.stringify(failure)}
original_run, original_scan, original_copy, original_fdopen = subprocess.run, os.scandir, shutil.copyfileobj, os.fdopen
opened = []
original_symlink = os.symlink
def symlink(target, name, *args, **kwargs):
    if failure == "output-link" and name.endswith("/scripts/npm-style"): target = "../engine.wasm"
    return original_symlink(target, name, *args, **kwargs)
os.symlink = symlink
def run(args, **kwargs):
    if failure == "lipo" and args[0] == "/usr/bin/lipo" or failure == "file-exit" and args[0] == "/usr/bin/file":
        raise OSError("injected tool failure")
    if args[0] == "/usr/bin/file" and failure == "file-unknown":
        return subprocess.CompletedProcess(args, 0, b"unrecognized native format\\0" * len(kwargs["pass_fds"]))
    if args[0] == "/usr/bin/file" and failure in ("file-framing", "file-empty", "file-error"):
        return subprocess.CompletedProcess(args, 0, b"truncated" if failure == "file-framing" else (b"" if failure == "file-empty" else b"ERROR: injected\\0" * len(kwargs["pass_fds"])))
    if args[0] == "/usr/bin/lipo":
        fd = args[-1].encode()
        thin = b"Non-fat file: " + fd + b" is architecture: "
        fat = b"Architectures in the fat file: " + fd + b" are: "
        faults = {
            "lipo-framing": thin + b"arm64???\\n",
            "lipo-unknown": thin + b"unknown\\n",
            "lipo-fat-unknown": fat + b"arm64 unknown \\n",
            "lipo-wrong-fd": b"Non-fat file: " + fd + b"0 is architecture: arm64\\n",
            "lipo-fat-wrong-fd": b"Architectures in the fat file: " + fd + b"0 are: arm64 x86_64 \\n",
            "lipo-prefix": b"unexpected header arm64\\n",
            "lipo-multiline": thin + b"arm64\\n" + thin + b"x86_64\\n",
            "lipo-incomplete": thin + b"arm64",
            "lipo-empty": fat + b"\\n",
        }
        if failure in faults: return subprocess.CompletedProcess(args, 0, faults[failure])
    return original_run(args, **kwargs)
def scan(fd):
    if failure == "scan" and os.fstat(fd).st_ino == original_stat.st_ino: raise OSError("injected scan failure")
    return original_scan(fd)
def copy(source, destination, *args):
    original_copy(source, destination, *args)
    if failure == "copy": raise OSError("injected copy failure")
def fdopen(*args, **kwargs):
    stream = original_fdopen(*args, **kwargs)
    opened.append(stream)
    if failure == "close" and len(opened) == 2:
        original_close = stream.close
        def close():
            original_close()
            raise OSError("injected close failure")
        stream.close = close
    return stream
original_stat = os.stat(${JSON.stringify(fixture.source)})
subprocess.run, os.scandir, shutil.copyfileobj, os.fdopen = run, scan, copy, fdopen
import atexit
@atexit.register
def verify_closed():
    assert all(stream.closed for stream in opened), "leaked source stream"
`,
        });
        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stderr).toMatch(
          /injected|Incomplete worker|Invalid worker|Uncertain worker|Unclassified worker|equivalent output target/,
        );
        expect(result.stderr).not.toContain("leaked source stream");
        expect(existsSync(fixture.destination)).toBe(false);
        expect(snapshot(fixture.source)).toEqual(before);
      }),
    );

    it.for(["before-open", "before-scan", "after-classification", "symlink-aba"])(
      "rejects source substitution %s without reading outside bytes or publishing",
      (schedule, { mac }) =>
        mac.lifetime.run(async () => {
          const fixture = await materializationFixture(mac);
          const inside = path.join(fixture.source, "images");
          const outside = path.join(fixture.root, "outside");
          const outsideBytes = Buffer.concat([
            fixture.binaries.arm64,
            Buffer.from("outside sentinel"),
          ]);
          await write(path.join(outside, "arm64"), outsideBytes);
          if (schedule === "symlink-aba") {
            await write(path.join(fixture.source, "a.txt"), "original resource");
            await write(path.join(fixture.source, "b.txt"), "substituted resource");
            await symlink("a.txt", path.join(fixture.source, "alias"));
          }
          const before = snapshot(fixture.source);
          const result = await fixture.run("arm64", {
            prelude: `
import os, shutil, subprocess, json
inside, outside = ${JSON.stringify(inside)}, ${JSON.stringify(outside)}
schedule = ${JSON.stringify(schedule)}
original_stat, original_scan, original_run, original_copy = os.stat, os.scandir, subprocess.run, shutil.copyfileobj
original_open, outside_inode, outside_opened = os.open, os.stat(os.path.join(outside, "arm64")).st_ino, []
def open_fd(*args, **kwargs):
    fd = original_open(*args, **kwargs)
    if os.fstat(fd).st_ino == outside_inode: outside_opened.append(True)
    return fd
os.open = open_fd
inode = os.stat(inside).st_ino
initial_fds = len(os.listdir("/dev/fd"))
original_readlink = os.readlink
changed = False
copied = []
def readlink(name, *, dir_fd=None):
    global changed
    if not changed and schedule == "symlink-aba" and name == "alias" and dir_fd is not None:
        changed = True
        held = os.path.join(outside, "held-alias")
        os.rename(name, held, src_dir_fd=dir_fd)
        try:
            os.symlink("b.txt", name, dir_fd=dir_fd)
            return original_readlink(name, dir_fd=dir_fd)
        finally:
            os.unlink(name, dir_fd=dir_fd)
            os.rename(held, name, dst_dir_fd=dir_fd)
    return original_readlink(name, dir_fd=dir_fd)
os.readlink = readlink
def replace():
    global changed
    changed = True
    target = os.path.join(inside, "arm64") if schedule == "after-classification" else inside
    os.rename(target, target + "-held")
    os.symlink(os.path.join(outside, "arm64") if schedule == "after-classification" else outside, target)
def info(name, *args, **kwargs):
    result = original_stat(name, *args, **kwargs)
    if not changed and schedule == "before-open" and result.st_ino == inode: replace()
    return result
def scan(fd):
    if not changed and schedule == "before-scan" and os.fstat(fd).st_ino == inode: replace()
    return original_scan(fd)
def run(args, **kwargs):
    result = original_run(args, **kwargs)
    if not changed and schedule == "after-classification" and args[0] == "/usr/bin/file": replace()
    return result
def copy(source, destination, *args):
    original_copy(source, destination, *args)
    destination.flush()
    if destination.name.endswith("/images/arm64"):
        with open(destination.name, "rb") as output: copied.append(output.read().hex())
os.stat, os.scandir, subprocess.run, shutil.copyfileobj = info, scan, run, copy
import atexit
@atexit.register
def evidence():
    with open(${JSON.stringify(path.join(fixture.root, "race.json"))}, "w") as output:
        json.dump({"changed": changed, "copied": copied, "outsideOpened": outside_opened, "initialFds": initial_fds, "finalFds": len(os.listdir("/dev/fd")) - 1}, output)
`,
          });
          const evidence = JSON.parse(
            readFileSync(path.join(fixture.root, "race.json"), "utf8"),
          ) as {
            changed: boolean;
            copied: string[];
            outsideOpened: boolean[];
            initialFds: number;
            finalFds: number;
          };
          expect(evidence.changed).toBe(true);
          expect(evidence.finalFds).toBe(evidence.initialFds);
          expect(evidence.outsideOpened).toEqual([]);
          expect(result.status, result.stderr).not.toBe(0);
          expect(result.stderr).toMatch(/Inventory|directory|symbolic link/i);
          expect(existsSync(fixture.destination)).toBe(false);
          expect(evidence.copied).toEqual(
            schedule === "before-open" || schedule === "symlink-aba"
              ? []
              : [fixture.binaries.arm64.toString("hex")],
          );
          expect(readFileSync(path.join(outside, "arm64"))).toEqual(outsideBytes);
          if (schedule === "symlink-aba") {
            expect(snapshot(fixture.source)).toEqual(before);
            expect(readlinkSync(path.join(fixture.source, "alias"))).toBe("a.txt");
          }
        }),
    );

    it("rejects in-place source mutation restored after lipo before native omission", ({ mac }) =>
      mac.lifetime.run(async () => {
        const fixture = await materializationFixture(mac);
        const target = path.join(fixture.source, "images/arm64");
        const replacement = path.join(fixture.root, "replacement");
        await write(replacement, fixture.binaries.x86_64);
        const before = snapshot(fixture.source);
        const result = await fixture.run("arm64", {
          prelude: `
import atexit, json, os, subprocess
target = ${JSON.stringify(target)}
with open(target, "rb") as stream: original = stream.read()
with open(${JSON.stringify(replacement)}, "rb") as stream: replacement = stream.read()
original_info = os.stat(target)
initial_fds = len(os.listdir("/dev/fd"))
original_run, schedule = subprocess.run, []
def run(args, **kwargs):
    result = original_run(args, **kwargs)
    fds = kwargs.get("pass_fds", ())
    if any(os.fstat(fd).st_ino == original_info.st_ino for fd in fds):
        if args[0] == "/usr/bin/file" and not schedule:
            with open(target, "wb") as stream: stream.write(replacement)
            schedule.append("replaced after file classification")
        elif args[0] == "/usr/bin/lipo":
            assert result.stdout == ("Non-fat file: " + args[-1] + " is architecture: x86_64\\n").encode(), result.stdout
            schedule.append("lipo observed x86_64")
            with open(target, "wb") as stream: stream.write(original)
            os.utime(target, ns=(original_info.st_atime_ns, original_info.st_mtime_ns))
            schedule.append("restored before omission")
    return result
subprocess.run = run
@atexit.register
def evidence():
    current = os.stat(target)
    with open(${JSON.stringify(path.join(fixture.root, "omission.json"))}, "w") as output:
        json.dump({"schedule": schedule, "sameInode": current.st_ino == original_info.st_ino,
                   "changedCtime": current.st_ctime_ns != original_info.st_ctime_ns,
                   "sameMtime": current.st_mtime_ns == original_info.st_mtime_ns,
                   "initialFds": initial_fds, "finalFds": len(os.listdir("/dev/fd")) - 1}, output)
`,
        });
        const evidence = JSON.parse(
          readFileSync(path.join(fixture.root, "omission.json"), "utf8"),
        ) as {
          schedule: string[];
          sameInode: boolean;
          changedCtime: boolean;
          sameMtime: boolean;
          initialFds: number;
          finalFds: number;
        };
        expect(evidence.schedule).toEqual([
          "replaced after file classification",
          "lipo observed x86_64",
          "restored before omission",
        ]);
        expect(evidence.sameInode).toBe(true);
        expect(evidence.changedCtime).toBe(true);
        expect(evidence.sameMtime).toBe(true);
        expect(evidence.finalFds).toBe(evidence.initialFds);
        expect(snapshot(fixture.source)).toEqual(before);
        expect(result.status, result.stderr).not.toBe(0);
        expect(existsSync(fixture.destination)).toBe(false);
      }));

    it("bounds native batches and rewinds retained handles after real classifier reads", ({
      mac,
    }) =>
      mac.lifetime.run(async () => {
        const fixture = await materializationFixture(mac);
        for (let index = 0; index < 130; index++) {
          await write(path.join(fixture.source, `native-${index}`), fixture.binaries.arm64);
          await write(path.join(fixture.source, `resource-${index}.js`), "// ordinary resource\n");
        }
        const before = snapshot(fixture.source);
        const result = await fixture.run("arm64", {
          prelude: `
import os, subprocess, json, atexit
original_run = subprocess.run
batches = []
initial_fds = len(os.listdir("/dev/fd"))
def run(args, **kwargs):
    result = original_run(args, **kwargs)
    fds = kwargs.get("pass_fds", ())
    if args[0] == "/usr/bin/file": batches.append(len(fds))
    for fd in fds: os.lseek(fd, 0, os.SEEK_END)
    return result
subprocess.run = run
@atexit.register
def evidence():
    with open(${JSON.stringify(path.join(fixture.root, "batches.json"))}, "w") as output:
        json.dump({"batches": batches, "initial": initial_fds, "final": len(os.listdir("/dev/fd")) - 1}, output)
`,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(snapshot(fixture.destination)).toEqual(
          before.filter((entry) => entry.path !== "images/elf"),
        );
        expect(snapshot(fixture.source)).toEqual(before);
        const evidence = JSON.parse(
          readFileSync(path.join(fixture.root, "batches.json"), "utf8"),
        ) as { batches: number[]; initial: number; final: number };
        expect(evidence.batches.length).toBeLessThanOrEqual(3);
        expect(Math.max(...evidence.batches)).toBeLessThanOrEqual(64);
        expect(evidence.batches.reduce((sum, size) => sum + size, 0)).toBe(133);
        expect(evidence.final).toBe(evidence.initial);
      }));

    it("rejects special input files without blocking or publishing", ({ mac }) =>
      mac.lifetime.run(async () => {
        const fixture = await materializationFixture(mac);
        await runMacFixtureTool(
          "/usr/bin/mkfifo",
          [path.join(fixture.source, "fifo")],
          fixture.root,
          mac,
        );
        const result = await fixture.run();
        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stderr).toContain("Unsupported worker filesystem entry");
        expect(existsSync(fixture.destination)).toBe(false);
      }));

    it("feeds freshly derived worker pairs to the real portable consumer", async ({ mac }) =>
      mac.lifetime.run(async () => {
        const harness = await artifactFixture(mac);
        for (const arch of ["arm64", "x86_64"] as const) {
          const worker = harness.at(`Contents/Resources/node-worker/${arch}`);
          const canonical = path.join(harness.home, `canonical-${arch}`);
          await rename(worker, canonical);
          await write(
            path.join(canonical, "nested/win32/README.md"),
            "Windows source is retained\n",
          );
          await write(path.join(canonical, "nested/win32/foreign.node"), harness.binaries.pe);
          await write(
            path.join(canonical, "opposite-mac.node"),
            harness.binaries[arch === "arm64" ? "x86_64" : "arm64"],
          );
          const before = snapshot(canonical);
          const result = await mac.run(
            "/usr/bin/python3",
            ["-B", materializer, canonical, worker, path.dirname(worker), arch],
            {
              encoding: "utf8",
              env: { HOME: harness.home, TMPDIR: harness.home, PATH: systemPath },
            },
          );
          expect(result.status, result.stderr).toBe(0);
          expect(snapshot(canonical)).toEqual(before);
          expect(snapshot(worker)).toEqual(
            before.filter(
              ({ path: name }) =>
                !["nested/win32/foreign.node", "opposite-mac.node"].includes(name),
            ),
          );
        }
        const result = await harness.verify();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("Elevation artifact verified");
      }));
  });
}

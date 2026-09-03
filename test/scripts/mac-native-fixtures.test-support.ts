import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { MacScriptFixture } from "./mac-script-fixture.test-support.js";

const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

export async function runMacFixtureTool(
  command: string,
  args: string[],
  root: string,
  mac: MacScriptFixture,
) {
  const result = await mac.run(command, args, {
    encoding: "utf8",
    cwd: root,
    env: { HOME: root, TMPDIR: root, PATH: systemPath },
  });
  expect(result.error, `${command}: ${result.stderr}`).toBeUndefined();
  expect(result.status, `${command}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

type NativeFixtures = Record<
  | "arm64"
  | "x86_64"
  | "universal"
  | "fat64"
  | "universalArchive"
  | "coff"
  | "pe"
  | "armLibrary"
  | "intelLibrary"
  | "universalLibrary"
  | "elf"
  | "armArchive"
  | "intelArchive",
  Buffer
>;
type PreparedNativeFixtures = {
  binaries: NativeFixtures;
  objects: Record<"arm64" | "x86_64", Buffer>;
};
let nativeFixtures: Promise<PreparedNativeFixtures> | undefined;

export async function macObjectFixture(
  root: string,
  arch: "arm64" | "x86_64",
  mac: MacScriptFixture,
) {
  return (await prepareMacNativeFixtures(root, mac)).objects[arch];
}

export async function macFatContainerFixture(
  root: string,
  slices: readonly Buffer[],
  fat64: boolean,
  mac: MacScriptFixture,
) {
  const inputs = [];
  for (const [index, bytes] of slices.entries()) {
    const file = path.join(root, `fat-container-input-${index}`);
    await writeFile(file, bytes);
    inputs.push(file);
  }
  const output = path.join(root, "fat-container");
  await runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", ...(fat64 ? ["-fat64"] : []), ...inputs, "-output", output],
    root,
    mac,
  );
  return readFile(output);
}

export async function singleSliceMacFat64(
  root: string,
  arch: "arm64" | "x86_64",
  mac: MacScriptFixture,
) {
  const input = path.join(root, `fat64-input-${arch}`);
  const output = path.join(root, `fat64-single-${arch}`);
  await writeFile(input, (await compiledMacNativeFixtures(root, mac))[arch]);
  await runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", "-fat64", input, "-output", output],
    root,
    mac,
  );
  expect(await runMacFixtureTool("/usr/bin/lipo", ["-archs", output], root, mac)).toBe(arch);
  const bytes = await readFile(output);
  expect(bytes.subarray(0, 4).toString("hex")).toBe("cafebabf");
  return bytes;
}

export async function compiledMacNativeFixtures(
  root: string,
  mac: MacScriptFixture,
): Promise<NativeFixtures> {
  return (await prepareMacNativeFixtures(root, mac)).binaries;
}

function prepareMacNativeFixtures(root: string, mac: MacScriptFixture) {
  if (nativeFixtures) {
    return nativeFixtures;
  }
  // The first case owns preparation; only complete in-memory bytes are shared.
  // A failed flight rejects its borrowers, but must not poison later case lifetimes.
  const preparation = mac.lifetime.run(() => compileMacNativeFixtures(root, mac));
  nativeFixtures = preparation;
  void preparation.catch(() => {
    if (nativeFixtures === preparation) {
      nativeFixtures = undefined;
    }
  });
  return preparation;
}

async function compileMacNativeFixtures(
  root: string,
  mac: MacScriptFixture,
): Promise<PreparedNativeFixtures> {
  const source = path.join(root, "inert.c");
  await writeFile(source, "int main(void) { return 0; }\n");
  const files = {
    arm64: path.join(root, "arm64"),
    x86_64: path.join(root, "x86_64"),
    universal: path.join(root, "universal"),
    fat64: path.join(root, "fat64"),
    universalArchive: path.join(root, "universal.a"),
    coff: path.join(root, "windows.obj"),
    armLibrary: path.join(root, "arm-library"),
    intelLibrary: path.join(root, "intel-library"),
    universalLibrary: path.join(root, "universal-library"),
    elf: path.join(root, "elf"),
    armArchive: path.join(root, "arm.a"),
    intelArchive: path.join(root, "intel.a"),
    armObject: path.join(root, "arm64.o"),
    intelObject: path.join(root, "x86_64.o"),
  };
  for (const arch of ["arm64", "x86_64"] as const) {
    for (const dynamic of [false, true]) {
      const output = dynamic
        ? files[arch === "arm64" ? "armLibrary" : "intelLibrary"]
        : files[arch];
      await runMacFixtureTool(
        "/usr/bin/xcrun",
        [
          "clang",
          "-arch",
          arch,
          "-mmacosx-version-min=14.0",
          "-Wl,-no_adhoc_codesign",
          ...(dynamic ? ["-dynamiclib"] : []),
          source,
          "-o",
          output,
        ],
        root,
        mac,
      );
      expect(await runMacFixtureTool("/usr/bin/lipo", ["-archs", output], root, mac)).toBe(arch);
    }
    const object = files[arch === "arm64" ? "armObject" : "intelObject"];
    const archive = files[arch === "arm64" ? "armArchive" : "intelArchive"];
    await runMacFixtureTool(
      "/usr/bin/xcrun",
      ["clang", "-arch", arch, "-c", source, "-o", object],
      root,
      mac,
    );
    await runMacFixtureTool("/usr/bin/ar", ["rcs", archive, object], root, mac);
    expect(await runMacFixtureTool("/usr/bin/lipo", ["-archs", archive], root, mac)).toBe(arch);
  }
  await runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", files.arm64, files.x86_64, "-output", files.universal],
    root,
    mac,
  );
  await runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", files.armLibrary, files.intelLibrary, "-output", files.universalLibrary],
    root,
    mac,
  );
  await runMacFixtureTool(
    "/usr/bin/xcrun",
    ["clang", "-target", "x86_64-unknown-linux-gnu", "-c", source, "-o", files.elf],
    root,
    mac,
  );
  expect(await runMacFixtureTool("/usr/bin/file", ["-b", files.elf], root, mac)).toContain("ELF");
  await runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", "-fat64", files.arm64, files.x86_64, "-output", files.fat64],
    root,
    mac,
  );
  await runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", files.armArchive, files.intelArchive, "-output", files.universalArchive],
    root,
    mac,
  );
  await runMacFixtureTool(
    "/usr/bin/xcrun",
    ["clang", "-target", "x86_64-pc-windows-msvc", "-c", source, "-o", files.coff],
    root,
    mac,
  );
  expect(await runMacFixtureTool("/usr/bin/file", ["-b", files.coff], root, mac)).toContain("COFF");
  // Minimal inert PE32+ image: DOS header, NT/optional headers, one .text section.
  const pe = Buffer.alloc(1024);
  pe.write("MZ");
  pe.writeUInt32LE(128, 60);
  pe.write("PE\0\0", 128);
  pe.writeUInt16LE(0x8664, 132);
  pe.writeUInt16LE(1, 134);
  pe.writeUInt16LE(240, 148);
  pe.writeUInt16LE(0x22, 150);
  pe.writeUInt16LE(0x20b, 152);
  pe.writeUInt32LE(4096, 168);
  pe.writeBigUInt64LE(0x140000000n, 176);
  pe.writeUInt32LE(4096, 184);
  pe.writeUInt32LE(512, 188);
  pe.writeUInt32LE(8192, 208);
  pe.writeUInt32LE(512, 212);
  pe.writeUInt16LE(3, 220);
  pe.write(".text", 392);
  pe.writeUInt32LE(1, 400);
  pe.writeUInt32LE(4096, 404);
  pe.writeUInt32LE(512, 408);
  pe.writeUInt32LE(512, 412);
  pe.writeUInt32LE(0x60000020, 428);
  pe[512] = 0xc3;
  const peFile = path.join(root, "windows.exe");
  await writeFile(peFile, pe);
  expect(await runMacFixtureTool("/usr/bin/file", ["-b", peFile], root, mac)).toContain("PE32+");
  return {
    binaries: {
      arm64: await readFile(files.arm64),
      x86_64: await readFile(files.x86_64),
      universal: await readFile(files.universal),
      fat64: await readFile(files.fat64),
      universalArchive: await readFile(files.universalArchive),
      coff: await readFile(files.coff),
      pe,
      armLibrary: await readFile(files.armLibrary),
      intelLibrary: await readFile(files.intelLibrary),
      universalLibrary: await readFile(files.universalLibrary),
      elf: await readFile(files.elf),
      armArchive: await readFile(files.armArchive),
      intelArchive: await readFile(files.intelArchive),
    },
    objects: { arm64: await readFile(files.armObject), x86_64: await readFile(files.intelObject) },
  };
}

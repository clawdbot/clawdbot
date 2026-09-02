import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runMacFixtureTool } from "../scripts/mac-native-fixtures.test-support.js";
import type { MacScriptFixture } from "../scripts/mac-script-fixture.test-support.js";

// SDK mach-o/{loader,fat}.h layouts; classification uses the host's real tools.
export function machoFixture(bits = 64, little = true, fat = false, fileType = 2): Buffer {
  const thin = Buffer.alloc(32);
  const write = (buffer: Buffer, value: number, offset: number) =>
    little ? buffer.writeUInt32LE(value, offset) : buffer.writeUInt32BE(value, offset);
  write(thin, bits === 64 ? 0xfeedfacf : 0xfeedface, 0);
  write(thin, bits === 64 ? 0x0100000c : 7, 4);
  write(thin, fileType, 12);
  if (!fat) {
    return thin;
  }
  const result = Buffer.alloc(4096 + thin.length);
  write(result, bits === 64 ? 0xcafebabf : 0xcafebabe, 0);
  write(result, 1, 4);
  write(result, bits === 64 ? 0x0100000c : 7, 8);
  if (bits === 64) {
    if (little) {
      result.writeBigUInt64LE(4096n, 16);
      result.writeBigUInt64LE(BigInt(thin.length), 24);
    } else {
      result.writeBigUInt64BE(4096n, 16);
      result.writeBigUInt64BE(BigInt(thin.length), 24);
    }
    write(result, 12, 32);
  } else {
    write(result, 4096, 16);
    write(result, thin.length, 20);
    write(result, 12, 24);
  }
  thin.copy(result, 4096);
  return result;
}

async function writeNativeObject(filename: string, arch: string, mac: MacScriptFixture) {
  const source = `${filename}.c`;
  await writeFile(source, "int native_fixture(void) { return 0; }\n");
  await runMacFixtureTool(
    "/usr/bin/xcrun",
    ["clang", "-arch", arch, "-x", "c", "-c", source, "-o", filename],
    path.dirname(filename),
    mac,
  );
}

export async function nativeObjectFixture(
  root: string,
  format: "thin" | "fat32" | "fat64",
  mac: MacScriptFixture,
): Promise<Buffer> {
  await mkdir(root);
  const inputs = [];
  for (const arch of format === "thin" ? ["arm64"] : ["arm64", "x86_64"]) {
    const filename = path.join(root, `${arch}.o`);
    await writeNativeObject(filename, arch, mac);
    inputs.push(filename);
  }
  if (format === "thin") {
    return readFile(path.join(root, "arm64.o"));
  }
  const filename = path.join(root, "object");
  await runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", ...(format === "fat64" ? ["-fat64"] : []), ...inputs, "-output", filename],
    root,
    mac,
  );
  return readFile(filename);
}

export async function writeFat64Fixture(filename: string, mac: MacScriptFixture): Promise<Buffer> {
  await runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", "-fat64", "/usr/bin/true", "-output", filename],
    path.dirname(filename),
    mac,
  );
  return readFile(filename);
}

export async function universalArchiveFixture(
  root: string,
  fat64: boolean,
  mixed: boolean,
  mac: MacScriptFixture,
): Promise<Buffer> {
  await mkdir(root);
  const inputs: string[] = [];
  for (const arch of ["arm64", "x86_64"]) {
    const object = path.join(root, `${arch}.o`);
    if (mixed && arch === "x86_64") {
      await runMacFixtureTool(
        "/usr/bin/lipo",
        ["-thin", arch, "/usr/bin/true", "-output", object],
        root,
        mac,
      );
      inputs.push(object);
      continue;
    }
    await writeNativeObject(object, arch, mac);
    const archive = path.join(root, `${arch}.a`);
    await runMacFixtureTool("/usr/bin/ar", ["rcs", archive, object], root, mac);
    inputs.push(archive);
  }
  const filename = path.join(root, "universal");
  await runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", ...(fat64 ? ["-fat64"] : []), ...inputs, "-output", filename],
    root,
    mac,
  );
  return readFile(filename);
}

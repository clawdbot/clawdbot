import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  SKILL_LIBRARY_MAX_FILES,
  type SkillLibraryFile,
  type SkillsLibraryReceipt,
  type SkillsLibraryUploadResult,
} from "../../packages/gateway-protocol/src/index.js";
import { callGatewayFromCliWithTransport, type GatewayRpcOpts } from "./gateway-rpc.js";

export async function readLibraryInput(input: string): Promise<{
  content: string;
  files?: SkillLibraryFile[];
}> {
  const root = path.resolve(input);
  const info = await fs.lstat(root);
  let total = 0;
  let count = 0;
  const files: SkillLibraryFile[] = [];
  let content: string | undefined;
  const read = async (file: string, relative: string) => {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) {
      throw new Error(`Only regular files are supported: ${relative}`);
    }
    total += stat.size;
    count += 1;
    if (
      stat.size > SKILL_LIBRARY_MAX_FILE_BYTES ||
      total > SKILL_LIBRARY_MAX_BUNDLE_BYTES ||
      count > SKILL_LIBRARY_MAX_FILES
    ) {
      throw new Error("Skill bundle exceeds the 1 MiB/file, 8 MiB/bundle, or 256-file limit.");
    }
    const bytes = await fs.readFile(file);
    if (relative === "SKILL.md") {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      return;
    }
    // Base64 round-trips every supporting file, including binary assets and CRLF text.
    files.push({
      path: relative,
      content: bytes.toString("base64"),
      encoding: "base64",
      executable: (stat.mode & 0o111) !== 0,
    });
  };
  const walk = async (directory: string, prefix = "") => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(directory, entry.name), relative);
      } else {
        await read(path.join(directory, entry.name), relative);
      }
    }
  };
  if (info.isDirectory()) {
    await walk(root);
  } else {
    await read(root, "SKILL.md");
  }
  if (content === undefined) {
    throw new Error("The bundle must contain SKILL.md at its root.");
  }
  return { content, ...(info.isDirectory() ? { files } : {}) };
}

export async function uploadLibraryZip(
  input: string,
  slug: string,
  opts: GatewayRpcOpts,
): Promise<SkillsLibraryReceipt> {
  const info = await fs.lstat(input);
  if (!info.isFile() || info.size < 1 || info.size > SKILL_LIBRARY_MAX_BUNDLE_BYTES) {
    throw new Error("ZIP import requires a regular file between 1 byte and 8 MiB.");
  }
  const bytes = await fs.readFile(input);
  const call = (params: unknown) =>
    callGatewayFromCliWithTransport<SkillsLibraryUploadResult>(
      "skills.library.upload",
      opts,
      params,
    );
  const begin = await call({
    action: "begin",
    slug,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  if (!("uploadId" in begin)) {
    throw new Error("Gateway did not open the upload. Retry the import.");
  }
  let offset = begin.offset;
  while (offset < bytes.length) {
    const end = Math.min(offset + begin.maxChunkBytes, bytes.length);
    const chunk = await call({
      action: "chunk",
      uploadId: begin.uploadId,
      offset,
      data: bytes.subarray(offset, end).toString("base64"),
    });
    if (!("offset" in chunk) || chunk.offset !== end) {
      throw new Error("Upload acknowledgement did not match the chunk. Retry the import.");
    }
    offset = chunk.offset;
  }
  const result = await call({ action: "commit", uploadId: begin.uploadId });
  if (!("state" in result)) {
    throw new Error("Gateway did not confirm publication. List your library before retrying.");
  }
  return result;
}

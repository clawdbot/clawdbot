import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { sanitizeUntrustedFileName } from "../../infra/fs-safe-advanced.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import { resolveInboundMediaReference } from "../../media/media-reference.js";
import { readMediaBuffer } from "../../media/store.js";
import { NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES } from "../../worker/node-workspace-protocol.js";
import { resolveChatAttachmentMaxBytes } from "../chat-attachment-policy.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import {
  WORKER_ATTACHMENT_DIRECTORY_PATTERN,
  WORKER_ATTACHMENT_DIRECTORY_PREFIX,
} from "./workspace-path-exclusions.js";

const MAX_TURN_ATTACHMENTS = 16;
// Fill the command's stdin budget without splitting a base64 quartet.
const ATTACHMENT_CHUNK_BYTES = Math.floor(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES / 4) * 3;

// Enter verified directories before mutation: process cwd pins the directory,
// including when another process renames it. All following names are basenames.
const STAGE_ATTACHMENT_SCRIPT = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const [workspace, directory, operation, directoryIdentity, name, offsetText, sizeText, hash, fileIdentity] = process.argv.slice(1);
const identity = (stat) => String(stat.dev) + ":" + String(stat.ino);
function enter(candidate, expected) {
  const before = fs.lstatSync(candidate);
  if (!before.isDirectory() || before.isSymbolicLink() || (expected && identity(before) !== expected)) throw Error("attachment directory changed");
  process.chdir(candidate);
  if (identity(fs.statSync(".")) !== identity(before)) throw Error("attachment directory changed");
}
try {
  if (/^${WORKER_ATTACHMENT_DIRECTORY_PATTERN}$/.exec(directory)?.[0] !== directory) throw Error("invalid attachment directory");
  enter(workspace);
  if (operation === "init") fs.mkdirSync(directory, {mode: 0o700});
  enter(directory, directoryIdentity);
  if (operation === "init") {
    process.stdout.write(identity(fs.statSync(".")));
  } else if (operation === "cleanup") {
    for (const entry of fs.readdirSync(".")) fs.unlinkSync(entry);
    enter(workspace);
    if (identity(fs.lstatSync(directory)) !== directoryIdentity) throw Error("attachment directory changed");
    fs.rmdirSync(directory);
  } else {
    if (operation !== "write" || !name || name === "." || name === ".." || /[\\/\x00]/.test(name)) throw Error("invalid attachment name");
    const offset = Number(offsetText), size = Number(sizeText);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < offset || size > ${MAX_PAYLOAD_BYTES}) throw Error("invalid attachment size");
    const encoded = fs.readFileSync(0, "utf8");
    if (encoded.length > ${Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4}) throw Error("attachment chunk exceeds limit");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || offset + bytes.length > size) throw Error("invalid attachment chunk");
    const partial = "." + name + ".part";
    if (offset > 0 && fs.lstatSync(partial).isSymbolicLink()) throw Error("attachment file changed");
    const flags = fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0) | (offset === 0 ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0);
    const fd = fs.openSync(partial, flags, 0o600);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size !== offset || (offset > 0 && identity(before) !== fileIdentity)) throw Error("attachment file changed");
      let written = 0;
      while (written < bytes.length) {
        const count = fs.writeSync(fd, bytes, written, bytes.length - written, offset + written);
        if (!count) throw Error("attachment write made no progress");
        written += count;
      }
      if (offset + bytes.length === size) {
        if (fs.fstatSync(fd).size !== size || crypto.createHash("sha256").update(fs.readFileSync(fd)).digest("hex") !== hash) throw Error("attachment checksum mismatch");
        fs.linkSync(partial, name);
        const published = fs.lstatSync(name);
        if (!published.isFile() || published.isSymbolicLink() || identity(published) !== identity(before)) throw Error("attachment publication changed");
        fs.unlinkSync(partial);
      }
      process.stdout.write(identity(before));
    } finally { fs.closeSync(fd); }
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

/** Transfers only admitted managed originals; workspace synchronization owns everything else. */
export async function prepareWorkerTurnAttachments(params: {
  turn: Pick<
    SessionPlacementTurnParams,
    "abortSignal" | "config" | "media" | "timeoutMs" | "userTurnTranscriptRecorder"
  >;
  tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand">;
  remoteWorkspaceDir: string;
  assertCurrent: () => void;
}): Promise<string | undefined> {
  const { turn, tunnel, assertCurrent } = params;
  const check = () => {
    turn.abortSignal?.throwIfAborted();
    assertCurrent();
  };
  check();
  const recorder = turn.userTurnTranscriptRecorder;
  const heldMessage = recorder?.message;
  const heldFacts = heldMessage && readPersistedMediaFacts(heldMessage);
  const message = heldFacts ? heldMessage : ((await recorder?.resolveMessage()) ?? heldMessage);
  check();
  // The recorder retains originals for inline images and facts already staged
  // locally. Runtime media alone omits those images or points at a host copy.
  const facts =
    heldFacts ?? (message ? readPersistedMediaFacts(message) : undefined) ?? turn.media ?? [];
  const files: Array<{ name: string; buffer: Buffer }> = [];
  const seen = new Set<string>();
  let remainingBytes = MAX_PAYLOAD_BYTES;
  const maxBytes = resolveChatAttachmentMaxBytes(turn.config ?? {});
  for (const fact of facts) {
    const sources = [fact.url, fact.path];
    let reference: Awaited<ReturnType<typeof resolveInboundMediaReference>> = null;
    for (const source of sources) {
      if (!source) {
        continue;
      }
      reference = await resolveInboundMediaReference(source);
      check();
      if (reference) {
        break;
      }
    }
    if (!reference) {
      if (sources.some((source) => source && !isPassThroughRemoteMediaSource(source))) {
        throw new Error(
          "Cloud attachment original is unavailable in managed media storage; attach the file again and retry.",
        );
      }
      continue;
    }
    if (seen.has(reference.id)) {
      continue;
    }
    seen.add(reference.id);
    if (files.length >= MAX_TURN_ATTACHMENTS) {
      throw new Error(
        `Cloud turns support at most ${MAX_TURN_ATTACHMENTS} original attachments; send fewer files and retry.`,
      );
    }
    const saved = await readMediaBuffer(
      reference.id,
      "inbound",
      Math.min(maxBytes, remainingBytes),
    );
    check();
    remainingBytes -= saved.buffer.length;
    const parsed = path.parse(
      sanitizeUntrustedFileName(fact.fileName ?? reference.id, "attachment"),
    );
    const name = `${files.length + 1}-${truncateUtf16Safe(parsed.name, 48)}${truncateUtf16Safe(parsed.ext, 12)}`;
    files.push({ name, buffer: saved.buffer });
  }
  if (!files.length) {
    return undefined;
  }
  const directory = `${WORKER_ATTACHMENT_DIRECTORY_PREFIX}${randomUUID()}`;
  const deadline = Date.now() + turn.timeoutMs;
  const execute = async (
    operation: "init" | "write" | "cleanup",
    args: string[] = [],
    input?: string,
  ): Promise<string> => {
    const cleanup = operation === "cleanup";
    const assertDispatchCurrent = cleanup ? assertCurrent : check;
    assertDispatchCurrent();
    const timeoutMs = cleanup ? 5_000 : Math.min(60_000, Math.max(1, deadline - Date.now()));
    if (!cleanup && Date.now() >= deadline) {
      throw new Error("Cloud attachment transfer timed out; retry this turn.");
    }
    const result = await tunnel.runWorkspaceCommand({
      argv: [
        "node",
        "-e",
        STAGE_ATTACHMENT_SCRIPT,
        params.remoteWorkspaceDir,
        directory,
        operation,
        ...args,
      ],
      ...(input === undefined ? {} : { input }),
      transportRetry: "never",
      assertCurrent: assertDispatchCurrent,
      timeoutMs,
      ...(!cleanup && turn.abortSignal ? { signal: turn.abortSignal } : {}),
    });
    assertDispatchCurrent();
    if (result.termination !== "exit" || result.code !== 0) {
      throw new Error(
        `Cloud attachment transfer failed: ${truncateUtf16Safe(result.stderr.trim() || "remote write failed", 512)}. Retry this turn.`,
      );
    }
    const identity = result.stdout.trim();
    if (!cleanup && !/^\d+:\d+$/.test(identity)) {
      const kind = operation === "init" ? "directory" : "file";
      throw new Error(`Cloud attachment transfer returned an invalid ${kind} identity.`);
    }
    return identity;
  };
  let directoryIdentity: string | undefined;
  try {
    directoryIdentity = await execute("init");
    for (const file of files) {
      const hash = createHash("sha256").update(file.buffer).digest("hex");
      let fileIdentity = "new";
      for (
        let offset = 0;
        offset === 0 || offset < file.buffer.length;
        offset += ATTACHMENT_CHUNK_BYTES
      ) {
        fileIdentity = await execute(
          "write",
          [
            directoryIdentity,
            file.name,
            String(offset),
            String(file.buffer.length),
            hash,
            fileIdentity,
          ],
          file.buffer.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES).toString("base64"),
        );
      }
    }
  } catch (error) {
    if (directoryIdentity) {
      await execute("cleanup", [directoryIdentity]).catch(() => undefined);
    }
    throw error;
  }
  // Only a fixed template and generated UUID enter model context, well below 2 KiB.
  return `Current attachment originals are available in this execution workspace at ${JSON.stringify(directory + "/")}. List that directory to find the attached files by name; use these copies when earlier attachment markers refer to Gateway-local storage.`;
}

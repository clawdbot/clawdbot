// Child-process entrypoint for one hard-cancellable sqlite-vec KNN query.
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  runVectorKnnQuery,
  type VectorKnnRequest,
  type VectorKnnResponse,
} from "./manager-search-knn.js";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

export type VectorKnnChildInput = {
  databasePath: string;
  extensionPath?: string;
  request: VectorKnnRequest;
};

export type VectorKnnChildResult =
  | { status: "ok"; value: VectorKnnResponse }
  | { status: "failed"; error: string };

function isChildInput(value: unknown): value is VectorKnnChildInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: the object guard above permits explicit validation of every field read below.
  const input = value as Partial<VectorKnnChildInput>;
  return (
    typeof input.databasePath === "string" &&
    input.databasePath.length > 0 &&
    Boolean(input.request) &&
    typeof input.request === "object"
  );
}

async function run(input: unknown): Promise<VectorKnnChildResult> {
  if (!isChildInput(input)) {
    return { status: "failed", error: "invalid memory vector KNN child input" };
  }
  const db = openNodeSqliteDatabase(input.databasePath, {
    allowExtension: true,
    readOnly: true,
  });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000");
    const loaded = await loadSqliteVecExtension({
      db,
      extensionPath: input.extensionPath,
    });
    if (!loaded.ok) {
      throw new Error(loaded.error ?? "sqlite-vec unavailable in memory search child");
    }
    return { status: "ok", value: runVectorKnnQuery(db, input.request) };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    db.close();
  }
}

function writeResult(result: VectorKnnChildResult): void {
  let payload = Buffer.from(JSON.stringify(result), "utf8");
  if (payload.byteLength > MAX_STDOUT_BYTES) {
    payload = Buffer.from(
      JSON.stringify({ status: "failed", error: "memory vector KNN child result is too large" }),
      "utf8",
    );
  }
  process.stdout.write(payload);
}

const chunks: Buffer[] = [];
let inputBytes = 0;
let inputTooLarge = false;
process.stdin.on("data", (chunk: Buffer) => {
  inputBytes += chunk.byteLength;
  if (inputBytes > MAX_STDIN_BYTES) {
    inputTooLarge = true;
    chunks.length = 0;
    return;
  }
  chunks.push(chunk);
});
process.stdin.once("end", () => {
  if (inputTooLarge) {
    writeResult({ status: "failed", error: "memory vector KNN child input is too large" });
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    writeResult({ status: "failed", error: "invalid memory vector KNN child JSON" });
    return;
  }
  void run(input).then(writeResult, (error: unknown) => {
    writeResult({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  });
});
process.stdin.resume();

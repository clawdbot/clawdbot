// Packs Node test shard groups for the CI job-output boundary.
//
// GitHub caps a job's outputs at 1 MiB measured in UTF-16, so the preflight
// manifest has 524,288 characters for every matrix combined. The full
// pull-request compact plan lists each striped test file explicitly, which
// alone reached that cap; gzip+base64 keeps the per-row payload proportional
// to the compressed file list instead of the raw path bytes. The shard runner
// unpacks the same envelope, so both sides must ship from one revision.
import { gunzipSync, gzipSync } from "node:zlib";

export function encodeNodeTestGroups(groups: readonly unknown[]): string {
  return gzipSync(Buffer.from(JSON.stringify(groups), "utf8")).toString("base64");
}

export function decodeNodeTestGroups(encoded: string): unknown[] {
  const parsed: unknown = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Packed node test groups must decode to a JSON array");
  }
  return parsed;
}

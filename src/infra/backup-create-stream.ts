import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

export async function writeArchiveStreamToFile(params: {
  archivePath: string;
  archiveStream: AsyncIterable<Uint8Array> | NodeJS.ReadableStream;
}): Promise<void> {
  // Own both stream lifecycles so a tar read error closes the output handle
  // before retry cleanup touches the partial archive. Exclusive creation also
  // refuses a pre-existing path instead of following a symlink.
  await pipeline(
    params.archiveStream,
    createWriteStream(params.archivePath, { flags: "wx", mode: 0o600 }),
  );
}

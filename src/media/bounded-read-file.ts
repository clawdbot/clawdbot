import type { OutboundMediaReadFile } from "./load-options.js";

type BoundedOutboundMediaReadFile = (
  filePath: string,
  options?: { maxBytes: number },
) => Promise<Buffer>;

const BOUNDED_OUTBOUND_MEDIA_READ_FILE = Symbol("boundedOutboundMediaReadFile");

type MarkedOutboundMediaReadFile = OutboundMediaReadFile & {
  [BOUNDED_OUTBOUND_MEDIA_READ_FILE]?: BoundedOutboundMediaReadFile;
};

/** Marks an owned reader that can reject oversized files before buffering them. */
export function createBoundedOutboundMediaReadFile(
  readFile: BoundedOutboundMediaReadFile,
): OutboundMediaReadFile {
  const wrapped = (async (filePath: string) =>
    await readFile(filePath)) as MarkedOutboundMediaReadFile;
  Object.defineProperty(wrapped, BOUNDED_OUTBOUND_MEDIA_READ_FILE, { value: readFile });
  return wrapped;
}

/** Passes source limits only to owned readers; public callbacks keep their one-argument contract. */
export async function readOutboundMediaFile(
  readFile: OutboundMediaReadFile,
  filePath: string,
  options: { maxBytes: number },
): Promise<Buffer> {
  const boundedReadFile = (readFile as MarkedOutboundMediaReadFile)[
    BOUNDED_OUTBOUND_MEDIA_READ_FILE
  ];
  return boundedReadFile ? await boundedReadFile(filePath, options) : await readFile(filePath);
}

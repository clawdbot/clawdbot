// Narrow response-size reader for plugins that download bounded HTTP bodies.

export { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
export { readResponseTextPrefix, readResponseWithLimit } from "../infra/http-body.js";
export type {
  ReadResponseTextPrefixOptions,
  ReadResponseTextPrefixResult,
} from "../infra/http-body.js";

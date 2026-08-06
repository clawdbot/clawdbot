// The core lane compiles with lib ES2023 (no DOM), so these web-global names
// no longer resolve. Derive them from the fetch globals @types/node already
// declares (backed by undici) instead of depending on undici-types directly;
// indexed-access derivation tracks @types/node across upgrades.
type BodyInit = Exclude<RequestInit["body"], undefined>;
type FormDataEntryValue = string | import("node:buffer").File;
type HeadersInit = Exclude<RequestInit["headers"], undefined>;
type ReadableStreamReadResult<T> =
  | import("node:stream/web").ReadableStreamReadDoneResult<T>
  | import("node:stream/web").ReadableStreamReadValueResult<T>;
type RequestCredentials = Exclude<RequestInit["credentials"], undefined>;
type RequestInfo = Parameters<typeof fetch>[0];

// Minimal surface for the one compile() caller; WebAssembly types otherwise
// live in lib.dom, which the core lane intentionally excludes.
declare namespace WebAssembly {
  type Module = object;

  function compile(bytes: ArrayBuffer | ArrayBufferView): Promise<Module>;
}

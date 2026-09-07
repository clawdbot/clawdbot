import type { CodeModeCatalogProjection } from "./code-mode-catalog.js";
import type { CodeModeApiVirtualFile, CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { createCodeModeToolApiFile } from "./code-mode-tool-api.js";
import { ToolInputError } from "./tool-input-error.js";
import type { ToolSearchRuntime } from "./tool-search-runtime.js";

const GLOBALS = `
declare function text(value: unknown): void;
declare function json(value: unknown): void;
declare function yield_control(reason?: string): Promise<void>;
declare function setTimeout<T extends unknown[]>(callback: (...args: T) => void, delay?: number, ...args: T): number;
declare function clearTimeout(id: number): void;
declare const console: { log(...values: unknown[]): void; info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void; debug(...values: unknown[]): void };
declare class TextEncoder { readonly encoding: string; encode(input?: string): Uint8Array; encodeInto(input: string, destination: Uint8Array): { read: number; written: number }; }
declare class TextDecoder { constructor(label?: string, options?: {fatal?: boolean; ignoreBOM?: boolean}); decode(input?: ArrayBuffer | ArrayBufferView, options?: {stream?: boolean}): string; readonly encoding: string; readonly fatal: boolean; readonly ignoreBOM: boolean; }
type CodeModeHandle = ((input?: unknown) => Promise<unknown>) & { callableName: string; toolName: string; description: string; describe(): Promise<unknown> };
declare const catalog: { search(query: string, options?: {limit?: number}): Promise<readonly CodeModeHandle[]>; all(): readonly CodeModeHandle[] };
type CodeModeApiFile = {path: string; description?: string; bytes: number; content: string};
declare const API: { list(prefix?: string): Promise<{files: Array<{path: string; description?: string; bytes?: number}>}>; read(path: string): Promise<CodeModeApiFile> };
declare const skills: { list(): Promise<unknown>; read(name: string): Promise<string> };
declare const nodes: unknown;
declare const namespaces: unknown;
`;

/** Opt-in only: use the same effective owner declarations as API.read. */
export async function createPreflightDeclarations(
  runtime: ToolSearchRuntime,
  projection: CodeModeCatalogProjection,
  apiFiles: CodeModeApiVirtualFile[],
  namespaces: CodeModeNamespaceRuntime,
  maxBytes: number,
): Promise<string> {
  const parts: string[] = [];
  let bytes = 0;
  const add = (text: string) => {
    bytes += Buffer.byteLength(text, "utf8") + 1;
    if (bytes > maxBytes) {
      throw new ToolInputError(
        "TypeScript preflight declarations exceed the existing memory allowance; narrow the catalog.",
      );
    }
    parts.push(text);
  };
  add(GLOBALS);
  for (const binding of projection.bindings) {
    add(
      (
        await createCodeModeToolApiFile(
          binding.callableName,
          await runtime.describe(binding.id, { includeMcp: false }),
        )
      ).content,
    );
  }
  for (const file of apiFiles) {
    add(file.content);
  }
  for (const descriptor of namespaces.descriptors) {
    if (descriptor.globalName !== "MCP") {
      add("declare const " + descriptor.globalName + ": unknown;");
    }
  }
  return parts.join("\n");
}

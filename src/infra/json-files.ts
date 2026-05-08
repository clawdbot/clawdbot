import "./fs-safe-defaults.js";
import { replaceFileAtomic } from "./replace-file.js";

export {
  JsonFileReadError,
  readJson,
  readJson as readJsonFileStrict,
  readJsonIfExists,
  readJsonIfExists as readDurableJsonFile,
  readJsonSync,
  readRootJsonObjectSync,
  readRootJsonSync,
  readRootStructuredFileSync,
  tryReadJson,
  tryReadJson as readJsonFile,
  tryReadJsonSync,
  tryReadJsonSync as readJsonFileSync,
  writeJson,
  writeJson as writeJsonAtomic,
  writeJsonSync,
} from "@openclaw/fs-safe/json";
export { createAsyncLock } from "@openclaw/fs-safe/advanced";

export type WriteTextAtomicOptions = {
  mode?: number;
  dirMode?: number;
  trailingNewline?: boolean;
  durable?: boolean;
};

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: WriteTextAtomicOptions,
): Promise<void> {
  const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  await replaceFileAtomic({
    filePath,
    content: payload,
    mode: options?.mode ?? 0o600,
    dirMode: options?.dirMode ?? 0o777 & ~process.umask(),
    copyFallbackOnPermissionError: true,
    syncTempFile: options?.durable !== false,
    syncParentDir: options?.durable !== false,
  });
}

import fs from "node:fs/promises";
import { password } from "@clack/prompts";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { parseSecretStoreDotEnvText } from "../secrets/store/dotenv.js";
import {
  SECRET_STORE_VALUE_MAX_BYTES,
  SecretStoreValidationError,
} from "../secrets/store/secret-store.js";

const SECRET_STORE_IMPORT_MAX_BYTES = 16 * 1024 * 1024;

function stripOneTerminalNewline(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

async function readBoundedStdin(maxBytes: number): Promise<string> {
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes,
    // Oversized input is the same validation failure as an oversized stored value,
    // so it must carry the typed code the CLI maps to exit 2 on every input path.
    onOverflow: ({ maxBytes: limit }) =>
      new SecretStoreValidationError(
        "SECRET_STORE_VALUE_TOO_LARGE",
        `Stdin input exceeds ${limit} bytes.`,
      ),
  });
  return bytes.toString("utf8");
}

async function readBoundedFile(pathname: string, maxBytes: number): Promise<string> {
  const file = await fs.open(pathname, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new Error(`Input path is not a regular file: ${pathname}`);
    }
    if (stat.size > maxBytes) {
      throw new SecretStoreValidationError(
        "SECRET_STORE_VALUE_TOO_LARGE",
        `Input file exceeds ${maxBytes} bytes: ${pathname}`,
      );
    }
    return (await readFileDescriptorBounded(file.fd, maxBytes)).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function readSecretStoreInput(params: { valueFile?: string }): Promise<string> {
  if (params.valueFile && params.valueFile !== "-") {
    return await readBoundedFile(params.valueFile, SECRET_STORE_VALUE_MAX_BYTES);
  }
  if (params.valueFile === "-" || !process.stdin.isTTY) {
    return stripOneTerminalNewline(await readBoundedStdin(SECRET_STORE_VALUE_MAX_BYTES));
  }
  const value = await password({
    message: "Secret value",
    // Empty masking prevents shoulder-surfing length disclosure as well as terminal echo.
    mask: "",
    validate: (candidate) =>
      Buffer.byteLength(candidate ?? "", "utf8") <= SECRET_STORE_VALUE_MAX_BYTES
        ? undefined
        : `Value exceeds ${SECRET_STORE_VALUE_MAX_BYTES} UTF-8 bytes.`,
  });
  if (typeof value === "symbol") {
    throw new Error("Secret input cancelled.");
  }
  return value;
}

export function parseSecretStoreDotEnv(raw: string | Buffer): Record<string, string> {
  return parseSecretStoreDotEnvText(raw.toString());
}

export async function readSecretStoreImport(from?: string): Promise<Record<string, string>> {
  const raw =
    from && from !== "-"
      ? await readBoundedFile(from, SECRET_STORE_IMPORT_MAX_BYTES)
      : await readBoundedStdin(SECRET_STORE_IMPORT_MAX_BYTES);
  return parseSecretStoreDotEnv(raw);
}

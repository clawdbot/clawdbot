import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

const MAX_RETURN_COVENANT_CONTROL_BYTES = 1024 * 1024;

export async function readReturnCovenantJsonFile(file: string): Promise<unknown> {
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 2 || info.size > MAX_RETURN_COVENANT_CONTROL_BYTES) {
      throw new Error(`return-covenant control file is not a bounded regular file: ${file}`);
    }
    const bytes = await handle.readFile();
    if (bytes.length > MAX_RETURN_COVENANT_CONTROL_BYTES) {
      throw new Error(
        `return-covenant control file exceeds ${MAX_RETURN_COVENANT_CONTROL_BYTES} bytes`,
      );
    }
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function writeReturnCovenantJsonFile(file: string, value: unknown): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

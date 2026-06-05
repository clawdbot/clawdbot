// Extracts progress markers from Parallels package E2E logs.
import fs from "node:fs";
import { readTextFileTail } from "../text-file-utils.mjs";

const LOG_PROGRESS_TAIL_BYTES = 256 * 1024;

const [logPath] = process.argv.slice(2);
if (!logPath || !fs.existsSync(logPath)) {
  console.log("");
  process.exit(0);
}

const text = readTextFileTail(logPath, LOG_PROGRESS_TAIL_BYTES);
const lines = text
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const reversed = lines.toReversed();

const progress = reversed.find((line) => line.startsWith("==> "));
const warning = reversed.find((line) => line.startsWith("warn:") || line.startsWith("error:"));
console.log(progress?.slice(4).trim() ?? warning ?? lines.at(-1)?.slice(0, 240) ?? "");

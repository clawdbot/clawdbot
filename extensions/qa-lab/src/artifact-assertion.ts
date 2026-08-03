import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { QaSuiteArtifactError } from "./errors.js";

export async function assertQaSuiteArtifactWritten(
  kind: "evidence" | "report" | "summary",
  filePath: string,
) {
  try {
    await fs.access(filePath);
  } catch (error) {
    throw new QaSuiteArtifactError(
      `${kind}_missing`,
      `QA suite did not produce ${kind} artifact at ${filePath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

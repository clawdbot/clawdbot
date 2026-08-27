import { formatErrorMessage } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";
import { finalizeCapturedOutput, type CapturedOutputBuffers } from "../process/exec-output.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";

export const NODE_WORKER_STDOUT_MAX_BYTES = 64 * 1024;
const STDERR_MAX_BYTES = 4 * 1024;

export type NodeWorkerCredentialScrubber = {
  maxRepresentationBytes: number;
  scrub: (text: string) => string;
};

export function createNodeWorkerCredentialScrubber(
  credentials: string | readonly string[],
): NodeWorkerCredentialScrubber {
  const values = typeof credentials === "string" ? [credentials] : credentials;
  const representations = new Set(
    values.flatMap((credential) => [
      credential,
      encodeURIComponent(credential),
      JSON.stringify(credential).slice(1, -1),
    ]),
  );
  const ordered = [...representations].toSorted((left, right) => right.length - left.length);
  return {
    maxRepresentationBytes: Math.max(
      ...ordered.map((representation) => Buffer.byteLength(representation, "utf8")),
    ),
    scrub: (text) => {
      let scrubbed = text;
      for (const representation of ordered) {
        scrubbed = scrubbed.replaceAll(representation, "[REDACTED]");
      }
      return scrubbed;
    },
  };
}

function redactLaunchText(value: string, scrubCredential: (text: string) => string): string {
  const launchRedacted = scrubCredential(value);
  const exactRedacted = redactRegisteredSecretValues(launchRedacted, () => "[REDACTED]");
  return redactToolPayloadText(exactRedacted);
}

export function sanitizeNodeWorkerDiagnostic(
  value: unknown,
  fallback: string,
  scrubCredential: (text: string) => string,
): string {
  const oneLine = redactLaunchText(formatErrorMessage(value), scrubCredential)
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf8Suffix(oneLine || fallback, STDERR_MAX_BYTES);
}

export function parseNodeWorkerSuccessfulResult(
  stdout: CapturedOutputBuffers,
  scrubCredential: (text: string) => string,
): string {
  if (stdout.truncatedBytes > 0) {
    throw new Error(`worker stdout exceeded ${NODE_WORKER_STDOUT_MAX_BYTES} bytes`);
  }
  const raw = finalizeCapturedOutput(stdout, "head", true).toString("utf8").trim();
  const redacted = redactLaunchText(raw, scrubCredential);
  let parsed: unknown;
  try {
    parsed = JSON.parse(redacted) as unknown;
  } catch (error) {
    throw new Error("worker returned invalid JSON output", { cause: error });
  }
  const result = JSON.stringify(parsed);
  if (Buffer.byteLength(result, "utf8") > NODE_WORKER_STDOUT_MAX_BYTES) {
    throw new Error(`worker result exceeded ${NODE_WORKER_STDOUT_MAX_BYTES} bytes`);
  }
  return result;
}

export const NODE_WORKER_STDERR_MAX_BYTES = STDERR_MAX_BYTES;

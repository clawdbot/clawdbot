import fs from "node:fs/promises";
import path from "node:path";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import { parseBuzzAuthTag } from "../relay-auth.js";
import { parseBuzzTarget } from "../target.js";
import { resolveBuzzPublicKey } from "../types.js";

function isSafeBuzzQaRelayUrl(value: string): boolean {
  try {
    const relayUrl = new URL(value);
    return (
      relayUrl.protocol === "wss:" ||
      (relayUrl.protocol === "ws:" && isLoopbackHost(relayUrl.hostname))
    );
  } catch {
    return false;
  }
}

const buzzQaCredentialPayloadSchema = z
  .object({
    // QA credentials may contain relay auth tags, so plaintext WebSockets must
    // stay on loopback and never cross a network boundary.
    relayUrl: z.string().url().refine(isSafeBuzzQaRelayUrl),
    roomId: z.string().min(1),
    driverPrivateKey: z.string().min(1),
    sutPrivateKey: z.string().min(1),
    driverAuthTag: z.string().optional(),
    sutAuthTag: z.string().optional(),
  })
  .strict();

export type BuzzQaCredentials = z.output<typeof buzzQaCredentialPayloadSchema> & {
  driverPublicKey: string;
  sutPublicKey: string;
};

export function parseBuzzQaCredentialPayload(payload: unknown): BuzzQaCredentials {
  const parsed = buzzQaCredentialPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Buzz QA credentials are missing or malformed.");
  }
  let roomId: string;
  let driverPublicKey: string;
  let sutPublicKey: string;
  try {
    roomId = parseBuzzTarget(parsed.data.roomId);
    driverPublicKey = resolveBuzzPublicKey(parsed.data.driverPrivateKey);
    sutPublicKey = resolveBuzzPublicKey(parsed.data.sutPrivateKey);
    parseBuzzAuthTag(parsed.data.driverAuthTag ?? "");
    parseBuzzAuthTag(parsed.data.sutAuthTag ?? "");
  } catch {
    throw new Error("Buzz QA credentials are missing or malformed.");
  }
  if (driverPublicKey === sutPublicKey) {
    throw new Error("Buzz QA requires distinct driver and SUT identities.");
  }
  return {
    ...parsed.data,
    roomId,
    driverPublicKey,
    sutPublicKey,
  };
}

export async function readBuzzQaCredentialFile(params: {
  filePath: string;
  repoRoot?: string;
}): Promise<BuzzQaCredentials> {
  const resolvedPath = path.resolve(params.repoRoot ?? process.cwd(), params.filePath);
  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read Buzz QA credential file ${resolvedPath}.`, { cause: error });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // JSON.parse errors may include source snippets, so never retain the
    // secret-bearing parser error as a cause.
    throw new Error(`Buzz QA credential file ${resolvedPath} is not valid JSON.`);
  }
  return parseBuzzQaCredentialPayload(payload);
}

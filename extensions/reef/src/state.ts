import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  base64url,
  fromBase64url,
  generateIdentity,
  type ReviewApproval,
  type ReviewRequest,
} from "../protocol/index.js";
import { JsonlAuditStore, FileReplayStore } from "../protocol/node.js";
import type { ReefKeys } from "./types.js";

export function resolveStateDir(configured?: string): string {
  return configured ?? join(homedir(), ".openclaw", "data", "reef");
}

export async function generateAndStoreKeys(stateDir: string): Promise<ReefKeys> {
  const identity = generateIdentity();
  const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
  const keys: ReefKeys = {
    ...identity,
    auditKey: base64url(random(32)),
    replayKey: base64url(random(32)),
    keyEpoch: 1,
  };
  await writePrivateJson(join(stateDir, "keys.json"), keys);
  return keys;
}

export async function loadKeys(stateDir: string): Promise<ReefKeys> {
  const value = JSON.parse(await readFile(join(stateDir, "keys.json"), "utf8")) as ReefKeys;
  if (
    fromBase64url(value.signing.secretKey).length !== 32 ||
    fromBase64url(value.encryption.secretKey).length !== 32 ||
    fromBase64url(value.auditKey).length !== 32 ||
    fromBase64url(value.replayKey).length !== 32 ||
    !Number.isSafeInteger(value.keyEpoch) ||
    value.keyEpoch < 1
  ) {
    throw new Error("invalid Reef key file");
  }
  await chmod(join(stateDir, "keys.json"), 0o600);
  return value;
}

export function openStores(stateDir: string, keys: ReefKeys) {
  return {
    audit: new JsonlAuditStore(join(stateDir, "audit.jsonl"), fromBase64url(keys.auditKey)),
    replay: new FileReplayStore(join(stateDir, "replay.jsonl"), fromBase64url(keys.replayKey)),
  };
}

export class ReviewApprovalStore {
  readonly path: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, "reviews.json");
  }

  async request(review: ReviewRequest): Promise<ReviewApproval | undefined> {
    const records = await this.read();
    const current = records[review.approvalDigest];
    if (current?.approved !== undefined) {
      return { approved: current.approved, approvalDigest: review.approvalDigest };
    }
    records[review.approvalDigest] = { review };
    await writePrivateJson(this.path, records);
    return undefined;
  }

  async decide(digest: string, approved: boolean): Promise<boolean> {
    const records = await this.read();
    if (!records[digest]) {
      return false;
    }
    records[digest] = { ...records[digest], approved };
    await writePrivateJson(this.path, records);
    return true;
  }

  async list(): Promise<ReviewRequest[]> {
    return Object.values(await this.read())
      .filter((entry) => entry.approved === undefined)
      .map((entry) => entry.review);
  }

  private async read(): Promise<Record<string, { review: ReviewRequest; approved?: boolean }>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<
        string,
        { review: ReviewRequest; approved?: boolean }
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

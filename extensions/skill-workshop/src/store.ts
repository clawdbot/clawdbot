import { createHash } from "node:crypto";
import path from "node:path";
import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
import type { SkillProposal, SkillWorkshopStatus } from "./types.js";

type StoreFile = {
  version: 1;
  proposals: SkillProposal[];
  review?: SkillWorkshopReviewState;
};

type SkillWorkshopReviewState = {
  turnsSinceReview: number;
  toolCallsSinceReview: number;
  lastReviewAt?: number;
};

const locks = new Map<string, Promise<void>>();

function workspaceKey(workspaceDir: string): string {
  return createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 16);
}

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(
    key,
    previous.then(() => next),
  );
  await previous;
  try {
    return await task();
  } finally {
    release?.();
    if (locks.get(key) === next) {
      locks.delete(key);
    }
  }
}

async function readJson(rootDir: string, relativePath: string): Promise<StoreFile> {
  const parsed = await privateFileStore(rootDir).readJsonIfExists<StoreFile>(relativePath);
  if (!parsed) {
    return { version: 1, proposals: [] };
  }
  return {
    version: 1,
    proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
    review:
      parsed.review && typeof parsed.review === "object"
        ? normalizeReviewState(parsed.review as Partial<SkillWorkshopReviewState>)
        : undefined,
  };
}

function normalizeReviewState(
  value: Partial<SkillWorkshopReviewState> = {},
): SkillWorkshopReviewState {
  return {
    turnsSinceReview:
      typeof value.turnsSinceReview === "number" && Number.isFinite(value.turnsSinceReview)
        ? Math.max(0, Math.trunc(value.turnsSinceReview))
        : 0,
    toolCallsSinceReview:
      typeof value.toolCallsSinceReview === "number" && Number.isFinite(value.toolCallsSinceReview)
        ? Math.max(0, Math.trunc(value.toolCallsSinceReview))
        : 0,
    ...(typeof value.lastReviewAt === "number" && Number.isFinite(value.lastReviewAt)
      ? { lastReviewAt: value.lastReviewAt }
      : {}),
  };
}

async function atomicWriteJson(
  rootDir: string,
  relativePath: string,
  data: StoreFile,
): Promise<void> {
  await privateFileStore(rootDir).writeJson(relativePath, data, {
    trailingNewline: true,
  });
}

export class SkillWorkshopStore {
  readonly stateDir: string;
  readonly filePath: string;
  private readonly relativePath: string;

  constructor(params: { stateDir: string; workspaceDir: string }) {
    this.stateDir = path.resolve(params.stateDir);
    this.relativePath = path.join("skill-workshop", `${workspaceKey(params.workspaceDir)}.json`);
    this.filePath = path.join(this.stateDir, this.relativePath);
  }

  async list(status?: SkillWorkshopStatus): Promise<SkillProposal[]> {
    const file = await readJson(this.stateDir, this.relativePath);
    const proposals = status
      ? file.proposals.filter((proposal) => proposal.status === status)
      : file.proposals;
    return proposals.toSorted((left, right) => right.createdAt - left.createdAt);
  }

  async get(id: string): Promise<SkillProposal | undefined> {
    return (await this.list()).find((proposal) => proposal.id === id);
  }

  async add(proposal: SkillProposal, maxPending: number): Promise<SkillProposal> {
    return await withLock(this.filePath, async () => {
      const file = await readJson(this.stateDir, this.relativePath);
      const duplicate = file.proposals.find(
        (item) =>
          (item.status === "pending" || item.status === "quarantined") &&
          item.skillName === proposal.skillName &&
          JSON.stringify(item.change) === JSON.stringify(proposal.change),
      );
      if (duplicate) {
        return duplicate;
      }
      const nextProposals = [proposal, ...file.proposals].filter((item, index, all) => {
        if (item.status !== "pending" && item.status !== "quarantined") {
          return true;
        }
        return (
          all
            .slice(0, index + 1)
            .filter(
              (candidate) => candidate.status === "pending" || candidate.status === "quarantined",
            ).length <= maxPending
        );
      });
      await atomicWriteJson(this.stateDir, this.relativePath, {
        ...file,
        version: 1,
        proposals: nextProposals,
      });
      return proposal;
    });
  }

  async updateStatus(id: string, status: SkillWorkshopStatus): Promise<SkillProposal> {
    return await withLock(this.filePath, async () => {
      const file = await readJson(this.stateDir, this.relativePath);
      const index = file.proposals.findIndex((proposal) => proposal.id === id);
      if (index < 0) {
        throw new Error(`proposal not found: ${id}`);
      }
      const updated = { ...file.proposals[index], status, updatedAt: Date.now() };
      file.proposals[index] = updated;
      await atomicWriteJson(this.stateDir, this.relativePath, file);
      return updated;
    });
  }

  async recordReviewTurn(toolCalls: number): Promise<SkillWorkshopReviewState> {
    return await withLock(this.filePath, async () => {
      const file = await readJson(this.stateDir, this.relativePath);
      const current = normalizeReviewState(file.review);
      const next = {
        ...current,
        turnsSinceReview: current.turnsSinceReview + 1,
        toolCallsSinceReview: current.toolCallsSinceReview + Math.max(0, Math.trunc(toolCalls)),
      };
      await atomicWriteJson(this.stateDir, this.relativePath, { ...file, review: next });
      return next;
    });
  }

  async markReviewed(): Promise<SkillWorkshopReviewState> {
    return await withLock(this.filePath, async () => {
      const file = await readJson(this.stateDir, this.relativePath);
      const next = {
        turnsSinceReview: 0,
        toolCallsSinceReview: 0,
        lastReviewAt: Date.now(),
      };
      await atomicWriteJson(this.stateDir, this.relativePath, { ...file, review: next });
      return next;
    });
  }
}

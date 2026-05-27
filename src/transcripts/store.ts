import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import type { TranscriptsSummary } from "./summary.js";
import { renderTranscriptsMarkdown } from "./summary.js";

export type TranscriptsSessionEntry = {
  session: TranscriptSessionDescriptor;
  sessionDir: string;
};

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function dateSegment(value: string | undefined): string {
  const isoDate = value?.match(/^(\d{4}-\d{2}-\d{2})T/)?.[1];
  return isoDate ?? new Date().toISOString().slice(0, 10);
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function normalizeMaxUtterances(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function sameSessionIdentity(
  left: TranscriptSessionDescriptor,
  right: TranscriptSessionDescriptor,
): boolean {
  return left.sessionId === right.sessionId && left.startedAt === right.startedAt;
}

export class TranscriptsStore {
  constructor(private readonly rootDir: string) {}

  sessionDir(session: TranscriptSessionDescriptor): string {
    return path.join(this.rootDir, dateSegment(session.startedAt), safeSegment(session.sessionId));
  }

  private async hasSessionMetadata(dir: string): Promise<boolean> {
    return (await readJsonFile<unknown>(path.join(dir, "metadata.json"))) !== undefined;
  }

  private async findSessionDirForSession(session: TranscriptSessionDescriptor): Promise<string> {
    const datedDir = this.sessionDir(session);
    const datedSession = await readJsonFile<TranscriptSessionDescriptor>(
      path.join(datedDir, "metadata.json"),
    );
    if (datedSession && sameSessionIdentity(datedSession, session)) {
      return datedDir;
    }
    return datedDir;
  }

  private async findSessionDir(selector: string): Promise<string | undefined> {
    const qualified = selector.match(/^(\d{4}-\d{2}-\d{2})\/(.+)$/);
    if (qualified?.[1] && qualified[2]) {
      const directDir = path.join(this.rootDir, qualified[1], safeSegment(qualified[2]));
      return (await this.hasSessionMetadata(directDir)) ? directDir : undefined;
    }

    const safeSessionId = safeSegment(selector);
    const idDate = selector
      .match(/^meeting-(\d{4})-(\d{2})-(\d{2})T/)
      ?.slice(1, 4)
      .join("-");
    if (idDate) {
      const directDir = path.join(this.rootDir, idDate, safeSessionId);
      return (await this.hasSessionMetadata(directDir)) ? directDir : undefined;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
    const datedEntries = entries
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .toSorted((left, right) => right.name.localeCompare(left.name));
    const matches: string[] = [];
    for (const entry of datedEntries) {
      const candidate = path.join(this.rootDir, entry.name, safeSessionId);
      const session = await readJsonFile<TranscriptSessionDescriptor>(
        path.join(candidate, "metadata.json"),
      );
      if (session?.sessionId === selector) {
        matches.push(candidate);
      }
    }
    if (matches.length > 1) {
      throw new Error(
        `multiple transcripts sessions match ${selector}; use a YYYY-MM-DD/${selector} selector`,
      );
    }
    return matches[0];
  }

  async writeSession(session: TranscriptSessionDescriptor): Promise<void> {
    const dir = this.sessionDir(session);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "metadata.json"), `${JSON.stringify(session, null, 2)}\n`);
  }

  async readSession(sessionId: string): Promise<TranscriptSessionDescriptor | undefined> {
    return (await this.readSessionEntry(sessionId))?.session;
  }

  async readSessionEntry(sessionId: string): Promise<TranscriptsSessionEntry | undefined> {
    const dir = await this.findSessionDir(sessionId);
    if (!dir) {
      return undefined;
    }
    const session = await readJsonFile<TranscriptSessionDescriptor>(
      path.join(dir, "metadata.json"),
    );
    return session ? { session, sessionDir: dir } : undefined;
  }

  async appendUtterance(sessionId: string, utterance: TranscriptUtterance): Promise<void> {
    const dir =
      (await this.findSessionDir(sessionId)) ??
      path.join(this.rootDir, dateSegment(sessionId), safeSegment(sessionId));
    await this.appendUtteranceToDir(dir, sessionId, utterance);
  }

  async appendUtteranceForSession(
    session: TranscriptSessionDescriptor,
    utterance: TranscriptUtterance,
  ): Promise<void> {
    const dir = await this.findSessionDirForSession(session);
    await this.appendUtteranceToDir(dir, session.sessionId, utterance);
  }

  private async appendUtteranceToDir(
    dir: string,
    sessionId: string,
    utterance: TranscriptUtterance,
  ): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      path.join(dir, "transcript.jsonl"),
      `${JSON.stringify({ ...utterance, sessionId })}\n`,
    );
  }

  async readUtterancesForSession(
    session: TranscriptSessionDescriptor,
    options: { maxUtterances?: number } = {},
  ): Promise<TranscriptUtterance[]> {
    return await this.readUtterancesFromDir(await this.findSessionDirForSession(session), options);
  }

  async readUtterancesFromSessionDir(
    sessionDir: string,
    options: { maxUtterances?: number } = {},
  ): Promise<TranscriptUtterance[]> {
    return await this.readUtterancesFromDir(sessionDir, options);
  }

  async readUtterances(
    sessionId: string,
    options: { maxUtterances?: number } = {},
  ): Promise<TranscriptUtterance[]> {
    const dir = await this.findSessionDir(sessionId);
    if (!dir) {
      return [];
    }
    return await this.readUtterancesFromDir(dir, options);
  }

  private async readUtterancesFromDir(
    dir: string,
    options: { maxUtterances?: number } = {},
  ): Promise<TranscriptUtterance[]> {
    const transcriptPath = path.join(dir, "transcript.jsonl");
    const maxUtterances = normalizeMaxUtterances(options.maxUtterances);
    if (maxUtterances !== undefined) {
      const utterances: TranscriptUtterance[] = [];
      try {
        const lines = createInterface({
          input: createReadStream(transcriptPath, { encoding: "utf8" }),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          if (!line) {
            continue;
          }
          utterances.push(JSON.parse(line) as TranscriptUtterance);
          if (utterances.length > maxUtterances) {
            utterances.shift();
          }
        }
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
          return [];
        }
        throw err;
      }
      return utterances;
    }
    let raw: string;
    try {
      raw = await fs.readFile(transcriptPath, "utf8");
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TranscriptUtterance);
  }

  async updateStopped(sessionId: string, stoppedAt: string): Promise<void> {
    const dir = await this.findSessionDir(sessionId);
    if (!dir) {
      return;
    }
    const session = await readJsonFile<TranscriptSessionDescriptor>(
      path.join(dir, "metadata.json"),
    );
    if (!session) {
      return;
    }
    await fs.writeFile(
      path.join(dir, "metadata.json"),
      `${JSON.stringify({ ...session, stoppedAt }, null, 2)}\n`,
    );
  }

  async writeSummary(
    summary: TranscriptsSummary,
    session?: TranscriptSessionDescriptor,
  ): Promise<string> {
    const dir =
      session !== undefined
        ? await this.findSessionDirForSession(session)
        : ((await this.findSessionDir(summary.sessionId)) ??
          path.join(this.rootDir, dateSegment(summary.sessionId), safeSegment(summary.sessionId)));
    return await this.writeSummaryToDir(summary, dir);
  }

  async writeSummaryToDir(summary: TranscriptsSummary, dir: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    const markdown = renderTranscriptsMarkdown(summary);
    const markdownPath = path.join(dir, "summary.md");
    await fs.writeFile(markdownPath, `${markdown}\n`);
    return markdownPath;
  }
}

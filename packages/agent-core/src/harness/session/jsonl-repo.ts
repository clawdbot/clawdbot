import type {
  FileSystem,
  JsonlSessionCreateOptions,
  JsonlSessionListOptions,
  JsonlSessionMetadata,
  JsonlSessionRepoApi,
  Session,
} from "../types.js";
import { SessionError, toError } from "../types.js";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "./jsonl-storage.js";
import {
  createSessionId,
  createTimestamp,
  getEntriesToFork,
  getFileSystemResultOrThrow,
  toSession,
} from "./repo-utils.js";

type JsonlSessionRepoFileSystem = Pick<
  FileSystem,
  | "cwd"
  | "absolutePath"
  | "joinPath"
  | "readTextFile"
  | "readTextLines"
  | "writeFile"
  | "appendFile"
  | "listDir"
  | "exists"
  | "createDir"
  | "remove"
>;

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export class JsonlSessionRepo implements JsonlSessionRepoApi {
  private readonly fs: JsonlSessionRepoFileSystem;
  private readonly sessionsRootInput: string;
  private sessionsRoot: string | undefined;

  constructor(options: { fs: JsonlSessionRepoFileSystem; sessionsRoot: string }) {
    this.fs = options.fs;
    this.sessionsRootInput = options.sessionsRoot;
  }

  private async getSessionsRoot(): Promise<string> {
    if (!this.sessionsRoot) {
      this.sessionsRoot = getFileSystemResultOrThrow(
        await this.fs.absolutePath(this.sessionsRootInput),
        `Failed to resolve sessions root ${this.sessionsRootInput}`,
      );
    }
    return this.sessionsRoot;
  }

  private async getSessionDir(cwd: string): Promise<string> {
    return getFileSystemResultOrThrow(
      await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
      `Failed to resolve session directory for ${cwd}`,
    );
  }

  private async createSessionFilePath(
    cwd: string,
    sessionId: string,
    timestamp: string,
  ): Promise<string> {
    return getFileSystemResultOrThrow(
      await this.fs.joinPath([
        await this.getSessionDir(cwd),
        `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
      ]),
      `Failed to resolve session file path for ${sessionId}`,
    );
  }

  async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
    const id = options.id ?? createSessionId();
    const createdAt = createTimestamp();
    const sessionDir = await this.getSessionDir(options.cwd);
    getFileSystemResultOrThrow(
      await this.fs.createDir(sessionDir, { recursive: true }),
      `Failed to create session directory ${sessionDir}`,
    );
    const filePath = await this.createSessionFilePath(options.cwd, id, createdAt);
    const storage = await JsonlSessionStorage.create(this.fs, filePath, {
      cwd: options.cwd,
      sessionId: id,
      parentSessionPath: options.parentSessionPath,
    });
    return toSession(storage);
  }

  async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
    if (
      !getFileSystemResultOrThrow(
        await this.fs.exists(metadata.path),
        `Failed to check session ${metadata.path}`,
      )
    ) {
      throw new SessionError("not_found", `Session not found: ${metadata.path}`);
    }
    const storage = await JsonlSessionStorage.open(this.fs, metadata.path);
    return toSession(storage);
  }

  async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
    const dirs = options.cwd
      ? [await this.getSessionDir(options.cwd)]
      : await this.listSessionDirs();
    const sessions: JsonlSessionMetadata[] = [];
    for (const dir of dirs) {
      if (
        !getFileSystemResultOrThrow(
          await this.fs.exists(dir),
          `Failed to check session directory ${dir}`,
        )
      ) {
        continue;
      }
      const files = getFileSystemResultOrThrow(
        await this.fs.listDir(dir),
        `Failed to list sessions in ${dir}`,
      ).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
      for (const file of files) {
        try {
          sessions.push(await loadJsonlSessionMetadata(this.fs, file.path));
        } catch (error) {
          const cause = toError(error);
          if (!(cause instanceof SessionError) || cause.code !== "invalid_session") {
            throw cause;
          }
        }
      }
    }
    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return sessions;
  }

  async delete(metadata: JsonlSessionMetadata): Promise<void> {
    getFileSystemResultOrThrow(
      await this.fs.remove(metadata.path, { force: true }),
      `Failed to delete session ${metadata.path}`,
    );
  }

  async fork(
    sourceMetadata: JsonlSessionMetadata,
    options: JsonlSessionCreateOptions & {
      entryId?: string;
      position?: "before" | "at";
      id?: string;
    },
  ): Promise<Session<JsonlSessionMetadata>> {
    const source = await this.open(sourceMetadata);
    const forkedEntries = await getEntriesToFork(source.getStorage(), options);
    const id = options.id ?? createSessionId();
    const createdAt = createTimestamp();
    const sessionDir = await this.getSessionDir(options.cwd);
    getFileSystemResultOrThrow(
      await this.fs.createDir(sessionDir, { recursive: true }),
      `Failed to create session directory ${sessionDir}`,
    );
    const storage = await JsonlSessionStorage.create(
      this.fs,
      await this.createSessionFilePath(options.cwd, id, createdAt),
      {
        cwd: options.cwd,
        sessionId: id,
        parentSessionPath: options.parentSessionPath ?? sourceMetadata.path,
      },
    );
    for (const entry of forkedEntries) {
      await storage.appendEntry(entry);
    }
    return toSession(storage);
  }

  private async listSessionDirs(): Promise<string[]> {
    const sessionsRoot = await this.getSessionsRoot();
    if (
      !getFileSystemResultOrThrow(
        await this.fs.exists(sessionsRoot),
        `Failed to check sessions root ${sessionsRoot}`,
      )
    ) {
      return [];
    }
    const entries = getFileSystemResultOrThrow(
      await this.fs.listDir(sessionsRoot),
      `Failed to list sessions root ${sessionsRoot}`,
    );
    return entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
  }
}

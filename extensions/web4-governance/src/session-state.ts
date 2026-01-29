/**
 * Session State - Tracks R6 chain state for a session.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SoftLCTToken } from "./soft-lct.js";

export type SessionState = {
  sessionId: string;
  lct: SoftLCTToken;
  actionIndex: number;
  lastR6Id?: string;
  startedAt: string;
  toolCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  /** Policy entity ID (policy:<name>:<version>:<hash>) */
  policyEntityId?: string;
};

export class SessionStore {
  private storagePath: string;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
    mkdirSync(join(this.storagePath, "sessions"), { recursive: true });
  }

  private filePath(sessionId: string): string {
    return join(this.storagePath, "sessions", `${sessionId}.json`);
  }

  save(state: SessionState): void {
    writeFileSync(this.filePath(state.sessionId), JSON.stringify(state, null, 2));
  }

  load(sessionId: string): SessionState | null {
    const path = this.filePath(sessionId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as SessionState;
    } catch {
      return null;
    }
  }

  incrementAction(state: SessionState, toolName: string, category: string, r6Id: string): void {
    state.actionIndex++;
    state.lastR6Id = r6Id;
    state.toolCounts[toolName] = (state.toolCounts[toolName] ?? 0) + 1;
    state.categoryCounts[category] = (state.categoryCounts[category] ?? 0) + 1;
    this.save(state);
  }
}

// Process-local Chrome MCP session and cleanup ownership state.
import type {
  ChromeMcpProcessCleanupDeps,
  ChromeMcpSession,
  ChromeMcpSessionFactory,
  PendingChromeMcpSession,
} from "./chrome-mcp-contracts.js";

export const chromeMcpSessions = new Map<string, ChromeMcpSession>();
export const pendingChromeMcpSessions = new Map<string, PendingChromeMcpSession>();
export const retainedChromeMcpCleanupSessions = new Map<string, Set<ChromeMcpSession>>();
export const chromeMcpCleanupPromises = new WeakMap<ChromeMcpSession, Promise<void>>();

let sessionFactory: ChromeMcpSessionFactory | null = null;
let processCleanupDeps: ChromeMcpProcessCleanupDeps | null = null;

export function getChromeMcpSessionFactory(): ChromeMcpSessionFactory | null {
  return sessionFactory;
}

export function setChromeMcpSessionFactory(factory: ChromeMcpSessionFactory | null): void {
  sessionFactory = factory;
}

export function getChromeMcpProcessCleanupDeps(): ChromeMcpProcessCleanupDeps | null {
  return processCleanupDeps;
}

export function setChromeMcpProcessCleanupDeps(deps: ChromeMcpProcessCleanupDeps | null): void {
  processCleanupDeps = deps;
}

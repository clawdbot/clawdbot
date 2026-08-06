import type { BrowserCopilotBinding } from "./panel-core.js";

export type CopilotSessionEntry = {
  tabId: number;
  browserInstanceId: string;
  gatewayScope: string;
  sessionKey: string;
  sessionId?: string;
  binding?: BrowserCopilotBinding;
  createdAt?: number;
  provisional?: boolean;
  creationPending?: boolean;
  activeRunId?: string;
  abortPending?: boolean;
};

export type CopilotArchiveEntry = {
  tabId?: number;
  gatewayScope: string;
  sessionKey: string;
  sessionId?: string;
  ensureCreated?: boolean;
  queuedAt: number;
};

export class CopilotPanelBindingRegistry {
  constructor(storage?: unknown);
  initialize(): Promise<void>;
  bind(tabId: number): Promise<string>;
  resolve(token: string): Promise<number | null>;
  remove(tabId: number): Promise<void>;
}

export class CopilotSessionRegistry {
  constructor(storage?: unknown);
  initialize(existingTabIds: Set<number>): Promise<string>;
  get(tabId: number, gatewayScope: string): CopilotSessionEntry | null;
  list(): CopilotSessionEntry[];
  gatewayScopes(): string[];
  pendingArchives(gatewayScope: string): CopilotArchiveEntry[];
  put(
    tabId: number,
    entry: Omit<CopilotSessionEntry, "tabId" | "browserInstanceId">,
  ): Promise<CopilotSessionEntry>;
  updateBinding(tabId: number, gatewayScope: string, binding: BrowserCopilotBinding): Promise<void>;
  confirmSession(
    tabId: number,
    gatewayScope: string,
    sessionId?: string,
  ): Promise<CopilotSessionEntry | null>;
  markSessionCreationPending(
    tabId: number,
    gatewayScope: string,
  ): Promise<CopilotSessionEntry | null>;
  discardProvisionalSession(tabId: number, gatewayScope: string): Promise<boolean>;
  startRun(tabId: number, gatewayScope: string, runId: string): Promise<CopilotSessionEntry | null>;
  queueAbort(tabId: number, gatewayScope: string): Promise<CopilotSessionEntry | null>;
  queueActiveAborts(gatewayScope: string): Promise<void>;
  pendingAborts(gatewayScope: string): CopilotSessionEntry[];
  finishRun(gatewayScope: string, sessionKey: string, runId: string): Promise<boolean>;
  closeTab(tabId: number): Promise<CopilotSessionEntry | null>;
  closeScope(gatewayScope: string): Promise<void>;
  closeInactiveScope(gatewayScope: string): Promise<void>;
  resolveArchive(gatewayScope: string, sessionKey: string): Promise<void>;
}

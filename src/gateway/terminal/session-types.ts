export type TerminalSessionSummary = {
  sessionId: string;
  agentId: string;
  shell: string;
  cwd: string;
  attached: boolean;
  createdAtMs: number;
};

export type TerminalAttachSummary = Omit<TerminalSessionSummary, "attached" | "createdAtMs"> & {
  buffer: string;
  seq: number;
};

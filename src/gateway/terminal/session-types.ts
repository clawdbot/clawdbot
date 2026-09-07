export type TerminalSessionSummary = {
  sessionId: string;
  agentId: string;
  shell: string;
  title?: string;
  cwd: string;
  attached: boolean;
  owner: "conn" | `agent:${string}`;
  createdAtMs: number;
};

export type TerminalAttachSummary = Omit<TerminalSessionSummary, "attached" | "createdAtMs"> & {
  buffer: string;
  seq: number;
};

export function createCopilotRelayCustodyController(options: Record<string, unknown>): {
  currentPanelStatus(): { state: string; label: string; requestId?: string };
  isOperational(): boolean;
  onStatus(status: { ready: boolean; label?: string }): Promise<void>;
};

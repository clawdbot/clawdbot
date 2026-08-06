export function waitForClickClackSocket(params: {
  baseUrl: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}): Promise<void>;
export function runReleaseUserJourneyAssertion(command: string, args?: string[]): Promise<void>;

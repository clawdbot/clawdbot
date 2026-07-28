export const TEAMS_MEETINGS_SYSTEM_PROFILER_COMMAND = "/usr/sbin/system_profiler";

export function outputMentionsBlackHole2ch(output: string): boolean {
  return /\bBlackHole\s+2ch\b/i.test(output);
}

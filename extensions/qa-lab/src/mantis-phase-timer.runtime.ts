// Qa Lab plugin module implements shared Mantis phase timing behavior.
type MantisPhaseTiming = {
  durationMs: number;
  finishedAt: string;
  name: string;
  startedAt: string;
  status: "accepted" | "fail" | "pass";
};

export type MantisPhaseTimings = {
  phases: MantisPhaseTiming[];
  totalMs: number;
};

export function createPhaseTimer(startedAt: Date) {
  const phases: MantisPhaseTiming[] = [];
  const origin = startedAt.getTime();
  function recordPhase(name: string, phaseStarted: Date, status: MantisPhaseTiming["status"]) {
    const phaseFinished = new Date();
    phases.push({
      durationMs: phaseFinished.getTime() - phaseStarted.getTime(),
      finishedAt: phaseFinished.toISOString(),
      name,
      startedAt: phaseStarted.toISOString(),
      status,
    });
  }
  async function timePhase<T>(name: string, run: () => Promise<T>): Promise<T> {
    const phaseStarted = new Date();
    try {
      const result = await run();
      recordPhase(name, phaseStarted, "pass");
      return result;
    } catch (error) {
      recordPhase(name, phaseStarted, "fail");
      throw error;
    }
  }
  function snapshot(now = new Date()): MantisPhaseTimings {
    return {
      phases: [...phases],
      totalMs: now.getTime() - origin,
    };
  }
  function updatePhaseStatus(name: string, status: MantisPhaseTiming["status"]) {
    const phase = phases.findLast((entry) => entry.name === name);
    if (phase) {
      phase.status = status;
    }
  }
  return { recordPhase, snapshot, timePhase, updatePhaseStatus };
}

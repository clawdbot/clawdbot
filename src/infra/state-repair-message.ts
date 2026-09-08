export function formatDoctorStateRepairFailure(problem: string, recovery: string): string {
  return `Doctor cannot repair this state: ${problem}. ${recovery}`;
}

export class DoctorUnreadableStateDatabaseError extends Error {
  constructor(path: string, reason: string) {
    super(
      formatDoctorStateRepairFailure(
        `shared state database is unreadable at ${path}: ${reason}`,
        "Stop OpenClaw processes, then restore this file from a verified backup; the unreadable database was left unchanged.",
      ),
    );
    this.name = "DoctorUnreadableStateDatabaseError";
  }
}

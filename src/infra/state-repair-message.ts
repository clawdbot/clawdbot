export function formatDoctorStateRepairFailure(problem: string, recovery: string): string {
  return `Doctor cannot repair this state: ${problem}. ${recovery}`;
}

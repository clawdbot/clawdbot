export type MeetingSetupCheck = {
  id: string;
  ok: boolean;
  message: string;
};

export type MeetingSetupStatus = {
  ok: boolean;
  checks: MeetingSetupCheck[];
};

export function createMeetingSetupStatus(checks: MeetingSetupCheck[]): MeetingSetupStatus {
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export function addMeetingSetupCheck(
  status: MeetingSetupStatus,
  check: MeetingSetupCheck,
): MeetingSetupStatus {
  return createMeetingSetupStatus([...status.checks, check]);
}

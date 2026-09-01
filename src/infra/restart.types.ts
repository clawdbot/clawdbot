// RestartAttempt records the supervisor mechanism tried by platform-specific
// restart paths.
export type RestartAttempt = {
  ok: boolean;
  method: "launchctl" | "systemd" | "schtasks" | "supervisor";
  detail?: string;
  tried?: string[];
};

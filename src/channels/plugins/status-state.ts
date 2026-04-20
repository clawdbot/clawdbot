export function formatChannelStatusState(statusState: string): string {
  switch (statusState) {
    case "linked":
      return "linked";
    case "not-linked":
      return "not linked";
    case "unstable":
      return "auth stabilizing";
    default:
      return statusState;
  }
}

export class HostDesktopCredentialsRequiredError extends Error {
  readonly auth = "ard-account" as const;
  readonly detailCode = "DESKTOP_CREDENTIALS_REQUIRED" as const;

  constructor() {
    super("macOS account credentials are required to observe Screen Sharing");
    this.name = "HostDesktopCredentialsRequiredError";
  }
}

export function isHostDesktopCredentialsRequiredError(
  error: unknown,
): error is HostDesktopCredentialsRequiredError {
  return error instanceof HostDesktopCredentialsRequiredError;
}

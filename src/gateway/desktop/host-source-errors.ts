export class DesktopCredentialsRequiredError extends Error {
  readonly detailCode = "DESKTOP_CREDENTIALS_REQUIRED" as const;

  constructor(
    readonly auth: "vnc-password" | "ard-account",
    message: string,
  ) {
    super(message);
    this.name = "DesktopCredentialsRequiredError";
  }
}

export class HostDesktopCredentialsRequiredError extends DesktopCredentialsRequiredError {
  declare readonly auth: "ard-account";

  constructor() {
    super("ard-account", "macOS account credentials are required to observe Screen Sharing");
    this.name = "HostDesktopCredentialsRequiredError";
  }
}

export function isDesktopCredentialsRequiredError(
  error: unknown,
): error is DesktopCredentialsRequiredError {
  return error instanceof DesktopCredentialsRequiredError;
}

export type SkillLibraryErrorCode =
  | "IDENTITY_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "NAME_CONFLICT"
  | "INVALID_BUNDLE"
  | "POLICY_BLOCKED"
  | "AUTHORITY_EXPIRED"
  | "LIMIT";

export class SkillLibraryError extends Error {
  constructor(
    readonly code: SkillLibraryErrorCode,
    message: string,
    readonly currentRevision?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillLibraryError";
  }
}

/** Legacy history requires an explicit Doctor import, never automatic failure triage. */
export class SessionStoreMigrationRequiredError extends Error {
  override name = "SessionStoreMigrationRequiredError";
}

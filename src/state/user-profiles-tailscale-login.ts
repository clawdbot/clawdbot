type ClassifiedTailscaleLogin =
  | { kind: "email"; email: string }
  | { kind: "provider"; provider: string; subject: string }
  | { kind: "invalid" };

export type TailscaleProfileIdentity = {
  login: string;
  name?: string;
  profilePic?: string;
};

/** Classify Tailscale's documented email or email-ish LoginName representation. */
export function classifyTailscaleLogin(login: string): ClassifiedTailscaleLogin {
  const normalized = login.trim();
  const separator = normalized.lastIndexOf("@");
  if (separator <= 0 || separator === normalized.length - 1) {
    return { kind: "invalid" };
  }
  const subject = normalized.slice(0, separator);
  const suffix = normalized.slice(separator + 1);
  return suffix.includes(".")
    ? { kind: "email", email: normalized }
    : { kind: "provider", provider: suffix.toLowerCase(), subject: subject.toLowerCase() };
}

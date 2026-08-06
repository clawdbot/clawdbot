export type DeprecatedWebInboundAdmissionTopLevelFields = {
  /** @deprecated Use `admission.conversation.id`. */
  from: string; // conversation id: E.164 for direct chats, group JID for groups
  /** @deprecated Use `admission.conversation.id`. */
  conversationId: string; // alias for clarity (same as from)
  /** @deprecated Use `admission.accountId`. */
  accountId: string;
  /**
   * @deprecated Use `admission.ingress.decision === "allow"`.
   *
   * Set by the real inbound monitor after access-control / pairing checks pass.
   * On messages with `admission`, this is a derived compatibility view; writes
   * are retained only for legacy inputs without an admission envelope.
   */
  accessControlPassed?: boolean;
  /** @deprecated Use `admission.conversation.kind`. */
  chatType: "direct" | "group";
};

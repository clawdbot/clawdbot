// Substitute `/approve <id>` placeholders with the concrete approval id while
// escaping `$` so an approvalId containing `$&`/`$1`-`$9`/`$$`/`` $` ``/`$'` is
// not interpreted as a regex replacement pattern by String.prototype.replace.
export function replaceApprovalIdPlaceholder(text: string | undefined, approvalId: string): string {
  const safeApprovalId = approvalId.replace(/\$/g, "$$$$");
  return (text ?? "").replace(/\/approve\s+<id>/g, `/approve ${safeApprovalId}`);
}

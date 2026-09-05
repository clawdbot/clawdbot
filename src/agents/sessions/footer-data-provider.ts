/** Read-only footer data supplied to session extensions. */
export interface ReadonlyFooterDataProvider {
  /** Current git branch, null if not in repo, "detached" if detached HEAD */
  getGitBranch(): string | null;

  /** Extension status texts set via ctx.ui.setStatus() */
  getExtensionStatuses(): ReadonlyMap<string, string>;

  /** Number of unique providers with available models (for footer display) */
  getAvailableProviderCount(): number;

  /** Subscribe to git branch changes. Returns unsubscribe function. */
  onBranchChange(callback: () => void): () => void;
}

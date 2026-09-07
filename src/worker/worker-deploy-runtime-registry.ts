let highlightJs: unknown;

export function setWorkerDeployHighlightJs(next: unknown): void {
  highlightJs = next;
}

export function getWorkerDeployHighlightJs(): unknown {
  return highlightJs;
}

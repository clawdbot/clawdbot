type AgentScopeSelection = {
  readonly state: { scopeId: string | null };
  subscribe: (listener: (state: { scopeId: string | null }) => void) => () => void;
};

/** Watches semantic scope changes across selection-source replacements. */
export function watchAgentScope(
  onChange: (scopeId: string | null, previousScopeId: string | null) => void,
): (selection: AgentScopeSelection) => () => void {
  let observedScopeId: string | null | undefined;
  return (selection) => {
    const sync = () => {
      const nextScopeId = selection.state.scopeId;
      if (observedScopeId === undefined) {
        observedScopeId = nextScopeId;
        return;
      }
      if (nextScopeId === observedScopeId) {
        return;
      }
      const previousScopeId = observedScopeId;
      observedScopeId = nextScopeId;
      onChange(nextScopeId, previousScopeId);
    };
    sync();
    return selection.subscribe(sync);
  };
}

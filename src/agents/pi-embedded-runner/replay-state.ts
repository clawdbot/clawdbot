export type EmbeddedRunReplayState = {
  replayInvalid: boolean;
  hadPotentialSideEffects: boolean;
};

export type EmbeddedRunReplayMetadata = {
  hadPotentialSideEffects: boolean;
  replaySafe: boolean;
};

export function createEmbeddedRunReplayState(
  state?: Partial<EmbeddedRunReplayState>,
): EmbeddedRunReplayState {
  return {
    replayInvalid: state?.replayInvalid === true,
    hadPotentialSideEffects: state?.hadPotentialSideEffects === true,
  };
}

export function mergeEmbeddedRunReplayState(
  current: EmbeddedRunReplayState,
  next?: Partial<EmbeddedRunReplayState>,
): EmbeddedRunReplayState {
  if (!next) {
    return current;
  }
  return {
    replayInvalid: current.replayInvalid || next.replayInvalid === true,
    hadPotentialSideEffects:
      current.hadPotentialSideEffects || next.hadPotentialSideEffects === true,
  };
}

export function observeReplayMetadata(
  current: EmbeddedRunReplayState,
  metadata: EmbeddedRunReplayMetadata,
): EmbeddedRunReplayState {
  return mergeEmbeddedRunReplayState(current, {
    replayInvalid: !metadata.replaySafe,
    hadPotentialSideEffects: metadata.hadPotentialSideEffects,
  });
}

export function replayMetadataFromState(state: EmbeddedRunReplayState): EmbeddedRunReplayMetadata {
  return {
    hadPotentialSideEffects: state.hadPotentialSideEffects,
    replaySafe: !state.replayInvalid && !state.hadPotentialSideEffects,
  };
}

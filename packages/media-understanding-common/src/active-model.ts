// Active media-understanding model selection contract.

/** Provider/model pair selected for one media-understanding request. */
export type ActiveMediaModel = {
  provider: string;
  model?: string;
};

export type FullSuiteVitestShard = {
  config: string;
  name: string;
  projects: string[];
};

export const autoReplyCoreTestInclude: string[];
export const autoReplyCoreTestExclude: string[];
export const autoReplyTopLevelReplyTestInclude: string[];
export const autoReplyReplySubtreeTestInclude: string[];
export const fullSuiteVitestShards: FullSuiteVitestShard[];

export type OpenClawPiCodingAgentSkillSourceAugmentation = never;

declare module "@earendil-works/pi-coding-agent" {
  interface Skill {
    // OpenClaw relies on the source identifier returned by pi skill loaders.
    source: string;
  }
}

declare module "osc-progress" {
  export type OscProgressController = {
    setIndeterminate: (label: string) => void;
    setPercent: (label: string, percent: number) => void;
    clear: () => void;
    done?: () => void;
  };

  export function createOscProgressController(params: {
    env: NodeJS.ProcessEnv;
    isTty: boolean;
    write: (chunk: string) => void;
  }): OscProgressController;

  export function supportsOscProgress(
    env: NodeJS.ProcessEnv,
    isTty: boolean,
  ): boolean;
}

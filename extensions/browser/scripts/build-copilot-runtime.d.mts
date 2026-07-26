type CopilotRuntimeBuild = (options: {
  bundle: boolean;
  entryPoints: string[];
  format: string;
  legalComments: string;
  minify: boolean;
  outfile: string;
  platform: string;
  target: string;
  tsconfig: string;
  write: false;
}) => Promise<{
  outputFiles?: Array<{ text: string }>;
}>;

/** Builds the Browser copilot runtime and returns whether the generated asset changed. */
export function buildCopilotRuntime(params?: {
  build?: CopilotRuntimeBuild;
  outputPath?: string;
}): Promise<boolean>;

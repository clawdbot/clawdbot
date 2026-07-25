type DiscordActivitySdkBuild = (options: {
  absWorkingDir: string;
  bundle: boolean;
  entryPoints: string[];
  format: string;
  legalComments: string;
  minify: boolean;
  outfile: string;
  platform: string;
  target: string;
  write: false;
}) => Promise<{
  outputFiles?: Array<{ text: string }>;
}>;

/** Builds the browser SDK bundle and returns whether the generated asset changed. */
export function buildDiscordActivitySdk(params?: {
  build?: DiscordActivitySdkBuild;
  outputPath?: string;
}): Promise<boolean>;

import { Command } from "commander";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getPluginCliCommandDescriptors } from "../../plugins/cli.js";
import type { PluginLoadOptions } from "../../plugins/loader.js";
import { VERSION } from "../../version.js";
import {
  addCommandDescriptorsToProgram,
  collectUniqueCommandDescriptors,
} from "./command-descriptor-utils.js";
import { getCoreCliCommandDescriptors } from "./core-command-descriptors.js";
import { configureProgramHelp } from "./help.js";
import { getSubCliEntries } from "./subcli-descriptors.js";

export type RootHelpRenderOptions = Pick<PluginLoadOptions, "pluginSdkResolution"> & {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includePluginDescriptors?: boolean;
};

async function buildRootHelpProgram(renderOptions?: RootHelpRenderOptions): Promise<Command> {
  const program = new Command();
  configureProgramHelp(program, {
    programVersion: VERSION,
    channelOptions: [],
    messageChannelOptions: "",
    agentChannelOptions: "",
  });

  const pluginDescriptors =
    renderOptions?.includePluginDescriptors === true || renderOptions?.config
      ? await getPluginCliCommandDescriptors(renderOptions.config, renderOptions.env, {
          pluginSdkResolution: renderOptions.pluginSdkResolution,
        })
      : [];

  addCommandDescriptorsToProgram(
    program,
    collectUniqueCommandDescriptors([
      getCoreCliCommandDescriptors(),
      getSubCliEntries(),
      pluginDescriptors,
    ]),
  );

  return program;
}

export async function renderRootHelpText(renderOptions?: RootHelpRenderOptions): Promise<string> {
  const program = await buildRootHelpProgram(renderOptions);
  let output = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  const captureWrite: typeof process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = captureWrite;
  try {
    program.outputHelp();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

export async function outputRootHelp(renderOptions?: RootHelpRenderOptions): Promise<void> {
  process.stdout.write(await renderRootHelpText(renderOptions));
}

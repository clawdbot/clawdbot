// Root program context: version plus lazily computed channel option strings for help text.
import { VERSION } from "../../version.js";
import { resolveCliChannelOptions } from "../channel-options.js";

/** Root CLI program context consumed by command registration and help rendering. */
export type ProgramContext = {
  programVersion: string;
  channelOptions: string[];
  messageChannelOptions: string;
  agentChannelOptions: string;
};

/** Create a program context that resolves channel options once on first use. */
export function createProgramContext(): ProgramContext {
  let cachedChannelOptions: string[] | undefined;
  const getChannelOptions = (): string[] => {
    if (cachedChannelOptions === undefined) {
      cachedChannelOptions = resolveCliChannelOptions();
    }
    return cachedChannelOptions;
  };

  return {
    programVersion: VERSION,
    get channelOptions() {
      return getChannelOptions();
    },
    get messageChannelOptions() {
      return getChannelOptions().join("|");
    },
    get agentChannelOptions() {
      return ["last", ...getChannelOptions()].join("|");
    },
  };
}

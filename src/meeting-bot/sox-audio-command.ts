export type MeetingSoxAudioFormat = {
  sampleRate: number;
  channels: number;
  encoding: string;
  bits: number;
  endian?: "little" | "big";
};

export type MeetingSoxAudioCommandParams = {
  bufferBytes: number;
  device?: string;
  deviceType?: string;
  format: MeetingSoxAudioFormat;
  inputExecutable?: string;
  outputExecutable?: string;
};

function formatArgs(format: MeetingSoxAudioFormat): string[] {
  return [
    "-t",
    "raw",
    "-r",
    String(format.sampleRate),
    "-c",
    String(format.channels),
    "-e",
    format.encoding,
    "-b",
    String(format.bits),
    ...(format.endian === "little" ? ["-L"] : format.endian === "big" ? ["-B"] : []),
    "-",
  ];
}

function withBuffer(executable: string, bufferBytes: number, args: string[]): string[] {
  return [executable, "-q", "--buffer", String(bufferBytes), ...args];
}

export function buildMeetingSoxAudioCommands(params: MeetingSoxAudioCommandParams): {
  inputCommand: string[];
  outputCommand: string[];
} {
  const wire = formatArgs(params.format);
  if (!params.device) {
    return {
      inputCommand: withBuffer(params.inputExecutable ?? "rec", params.bufferBytes, wire),
      outputCommand: withBuffer(params.outputExecutable ?? "play", params.bufferBytes, wire),
    };
  }
  const deviceType = params.deviceType ?? "coreaudio";
  return {
    inputCommand: withBuffer(params.inputExecutable ?? "sox", params.bufferBytes, [
      "-t",
      deviceType,
      params.device,
      ...wire,
    ]),
    outputCommand: withBuffer(params.outputExecutable ?? "sox", params.bufferBytes, [
      ...wire,
      "-t",
      deviceType,
      params.device,
    ]),
  };
}

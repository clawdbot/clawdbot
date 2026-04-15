const DOCTOR_CONFIG_TEST_INPUT = Symbol.for("openclaw.doctorConfigFlow.testInput");

type DoctorConfigTestInput = {
  config: Record<string, unknown>;
  exists: boolean;
  path: string;
  preflightMode: "fast" | "issues" | "compat";
};

function setDoctorConfigInputForTest(input: DoctorConfigTestInput | null): void {
  const globalState = globalThis as typeof globalThis & {
    [DOCTOR_CONFIG_TEST_INPUT]?: DoctorConfigTestInput;
  };
  if (input) {
    globalState[DOCTOR_CONFIG_TEST_INPUT] = input;
    return;
  }
  delete globalState[DOCTOR_CONFIG_TEST_INPUT];
}

export function getDoctorConfigInputForTest(): DoctorConfigTestInput | null {
  const globalState = globalThis as typeof globalThis & {
    [DOCTOR_CONFIG_TEST_INPUT]?: DoctorConfigTestInput;
  };
  return globalState[DOCTOR_CONFIG_TEST_INPUT] ?? null;
}

function shouldUseCompatPreflight(path: ReadonlyArray<string>, value: unknown): boolean {
  if (path.length === 0) {
    return false;
  }

  const joined = path.join(".");
  const last = path[path.length - 1];
  if (
    joined === "heartbeat" ||
    joined === "memorySearch" ||
    joined === "gateway.bind" ||
    joined === "hooks.internal.handlers"
  ) {
    return true;
  }
  if (
    joined === "channels.telegram.groupMentionsOnly" ||
    joined === "agents.defaults.sandbox.perSession"
  ) {
    return true;
  }
  if (path.length >= 4 && path[0] === "agents" && path[1] === "list" && last === "perSession") {
    return true;
  }
  if (last === "ttlHours" && path[path.length - 2] === "threadBindings") {
    return true;
  }
  if (
    last === "allow" &&
    typeof value === "boolean" &&
    ((path.length === 5 &&
      path[0] === "channels" &&
      path[1] === "slack" &&
      path[2] === "channels") ||
      (path.length === 5 &&
        path[0] === "channels" &&
        path[1] === "googlechat" &&
        path[2] === "groups") ||
      (path.length === 7 &&
        path[0] === "channels" &&
        path[1] === "discord" &&
        path[2] === "guilds" &&
        path[4] === "channels"))
  ) {
    return true;
  }
  if (
    last === "streamMode" ||
    last === "chunkMode" ||
    last === "blockStreaming" ||
    last === "draftChunk" ||
    last === "blockStreamingCoalesce" ||
    last === "nativeStreaming"
  ) {
    return true;
  }
  if (last === "streaming" && (typeof value === "boolean" || typeof value === "string")) {
    return true;
  }
  if (
    joined === "talk.voiceId" ||
    joined === "talk.voiceAliases" ||
    joined === "talk.modelId" ||
    joined === "talk.outputFormat" ||
    joined === "talk.apiKey"
  ) {
    return true;
  }
  return false;
}

function hasCompatPreflightSignals(config: Record<string, unknown>): boolean {
  const stack: Array<{ path: string[]; value: unknown }> = [{ path: [], value: config }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !current.value || typeof current.value !== "object") {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          path: [...current.path, String(index)],
          value: current.value[index],
        });
      }
      continue;
    }
    for (const [key, entry] of Object.entries(current.value)) {
      const nextPath = [...current.path, key];
      if (shouldUseCompatPreflight(nextPath, entry)) {
        return true;
      }
      if (entry && typeof entry === "object") {
        stack.push({ path: nextPath, value: entry });
      }
    }
  }
  return false;
}

export async function runDoctorConfigWithInput<T>(params: {
  config: Record<string, unknown>;
  repair?: boolean;
  preflightMode?: "fast" | "issues" | "compat";
  run: (args: {
    options: { nonInteractive: boolean; repair?: boolean };
    confirm: () => Promise<boolean>;
  }) => Promise<T>;
}) {
  const inferredPreflightMode = hasCompatPreflightSignals(params.config)
    ? params.repair
      ? "compat"
      : "issues"
    : "fast";
  setDoctorConfigInputForTest({
    config: structuredClone(params.config),
    exists: true,
    path: "/virtual/.openclaw/openclaw.json",
    preflightMode: params.preflightMode ?? inferredPreflightMode,
  });
  try {
    return await params.run({
      options: { nonInteractive: true, repair: params.repair },
      confirm: async () => false,
    });
  } finally {
    setDoctorConfigInputForTest(null);
  }
}

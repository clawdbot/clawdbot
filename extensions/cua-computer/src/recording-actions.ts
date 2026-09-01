import { z } from "zod";
import type { CuaComputerActParams } from "./action-targets.js";
import type { CuaDriverSession, CuaToolResult } from "./driver-client.js";
import type { CuaExecutionResources } from "./execution-resources.js";

const RecordingStateSchema = z.object({
  recording: z.boolean(),
  enabled: z.boolean(),
  output_dir: z.string().nullable(),
  next_turn: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  video_active: z.boolean(),
  last_video_path: z.string().nullable(),
  owner: z.string().nullable(),
});

const ReplayTurnSchema = z.object({
  turn: z.string(),
  tool: z.string().optional(),
  ok: z.boolean(),
  result_summary: z.string().optional(),
  parse_error: z.string().optional(),
});

const ReplayResultSchema = z.object({
  directory: z.string(),
  attempted: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  stop_on_error: z.boolean(),
  turns: z.array(ReplayTurnSchema),
  first_failure: z.object({ turn: z.string(), tool: z.string(), error: z.string() }).optional(),
});

const MAX_REPLAY_TURNS = 200;

export type CuaRecordingState = {
  active?: { resourceHandle: string };
};

function driverError(result: CuaToolResult, tool: string): Error {
  const code = result.errorCode ? `COMPUTER_REFUSED_${result.errorCode}` : "COMPUTER_DRIVER_ERROR";
  return new Error(`${code}: ${tool} failed; inspect node logs and resource state before retrying`);
}

function structured(result: CuaToolResult, tool: string): unknown {
  if (result.isError) {
    throw driverError(result, tool);
  }
  if (!result.structuredJson) {
    throw new Error(`COMPUTER_DRIVER_ERROR: ${tool} returned no structuredContent`);
  }
  try {
    return JSON.parse(result.structuredJson) as unknown;
  } catch (error) {
    throw new Error(`COMPUTER_DRIVER_ERROR: ${tool} returned invalid structuredContent`, {
      cause: error,
    });
  }
}

function projectRecordingState(
  native: z.infer<typeof RecordingStateSchema>,
  resourceHandle: string | undefined,
) {
  return {
    recording: native.enabled,
    nextTurn: native.next_turn,
    videoActive: native.video_active,
    ...(native.last_error
      ? { videoError: "video unavailable; per-turn trajectory capture remains active" }
      : {}),
    ...(resourceHandle ? { resourceHandle } : {}),
  };
}

async function stopOwnedRecording(params: {
  driver: CuaDriverSession;
  state: CuaRecordingState;
  resources: CuaExecutionResources;
  discard: boolean;
}): Promise<void> {
  const active = params.state.active;
  params.state.active = undefined;
  if (!active) {
    return;
  }
  let failure: unknown;
  try {
    const result = await params.driver.callTool("stop_recording", {});
    if (result.isError) {
      failure = driverError(result, "stop_recording");
    }
  } catch (error) {
    failure = error;
  }
  if (params.discard) {
    try {
      await params.resources.discard(active.resourceHandle);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) {
    throw failure instanceof Error
      ? failure
      : new Error("CUA recording cleanup failed", { cause: failure });
  }
}

function projectReplayTurn(turn: z.infer<typeof ReplayTurnSchema>) {
  const projected: Record<string, unknown> = { turn: turn.turn, ok: turn.ok };
  if (turn.tool) {
    projected.tool = turn.tool;
  }
  if (turn.parse_error) {
    projected.parseError = true;
  }
  return projected;
}

export async function closeRecordingExecution(params: {
  driver: CuaDriverSession;
  state: CuaRecordingState;
  resources: CuaExecutionResources;
  reason: string;
}): Promise<void> {
  await stopOwnedRecording({
    ...params,
    discard: params.reason !== "completion",
  });
}

export async function handleRecordingAct(
  driver: CuaDriverSession,
  state: CuaRecordingState,
  resources: CuaExecutionResources,
  input: CuaComputerActParams,
  signal?: AbortSignal,
): Promise<string | undefined> {
  switch (input.action) {
    case "get_recording_state": {
      if (!state.active) {
        return JSON.stringify({ ok: true, details: { recording: false } });
      }
      const native = RecordingStateSchema.parse(
        structured(await driver.callTool("get_recording_state", {}, signal), "get_recording_state"),
      );
      return JSON.stringify({
        ok: true,
        details: projectRecordingState(native, state.active.resourceHandle),
      });
    }
    case "start_recording": {
      if (state.active) {
        throw new Error(
          "COMPUTER_RECORDING_ACTIVE: stop the current recording before starting another",
        );
      }
      const resource = await resources.createDirectory("recording");
      try {
        const result = await driver.callTool(
          "start_recording",
          { output_dir: resource.path, record_video: input.recordVideo ?? false },
          signal,
        );
        const native = RecordingStateSchema.parse(structured(result, "start_recording"));
        if (!native.enabled) {
          throw new Error("COMPUTER_DRIVER_ERROR: start_recording returned disabled state");
        }
        state.active = { resourceHandle: resource.handle };
        return JSON.stringify({
          ok: true,
          details: projectRecordingState(native, resource.handle),
        });
      } catch (error) {
        // A failed call can still have landed. End this exact trusted driver
        // session so upstream stops only its owned recording; the public stop
        // tool is unconditional and could tear down another session's work.
        await driver.dispose().catch(() => {});
        await resources.discard(resource.handle).catch(() => {});
        throw error;
      }
    }
    case "stop_recording": {
      const active = state.active;
      if (!active) {
        return JSON.stringify({ ok: true, details: { recording: false } });
      }
      state.active = undefined;
      const native = RecordingStateSchema.parse(
        structured(await driver.callTool("stop_recording", {}, signal), "stop_recording"),
      );
      return JSON.stringify({
        ok: true,
        details: projectRecordingState(native, active.resourceHandle),
      });
    }
    case "replay_trajectory": {
      const resourceHandle = input.resourceHandle;
      if (!resourceHandle) {
        throw new Error(
          "COMPUTER_INVALID_REQUEST: resourceHandle is required for replay_trajectory",
        );
      }
      const directory = await resources.validateDirectoryTree(resourceHandle);
      const native = ReplayResultSchema.parse(
        structured(
          await driver.callTool(
            "replay_trajectory",
            {
              dir: directory,
              ...(input.delayMs !== undefined ? { delay_ms: input.delayMs } : {}),
              ...(input.stopOnError !== undefined ? { stop_on_error: input.stopOnError } : {}),
            },
            signal,
          ),
          "replay_trajectory",
        ),
      );
      return JSON.stringify({
        ok: true,
        details: {
          resourceHandle,
          attempted: native.attempted,
          succeeded: native.succeeded,
          failed: native.failed,
          stopOnError: native.stop_on_error,
          turns: native.turns.slice(0, MAX_REPLAY_TURNS).map(projectReplayTurn),
          ...(native.turns.length > MAX_REPLAY_TURNS
            ? { truncatedTurns: native.turns.length - MAX_REPLAY_TURNS }
            : {}),
          ...(native.first_failure
            ? {
                firstFailure: {
                  turn: native.first_failure.turn,
                  tool: native.first_failure.tool,
                },
              }
            : {}),
        },
      });
    }
  }
  return undefined;
}

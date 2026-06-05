// Media generation background test support centralizes task/announcement mocks
// and assertions shared by image, video, and music generation tests.
import { expect, vi } from "vitest";

type MockWithReset = {
  mockReset(): void;
  mockResolvedValue?(value: unknown): void;
};

export const taskExecutorMocks = {
  createRunningTaskRun: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
  completeTaskRunByRunId: vi.fn(),
  failTaskRunByRunId: vi.fn(),
};

export const announceDeliveryMocks = {
  deliverSubagentAnnouncement: vi.fn(),
};

export const taskDeliveryRuntimeMocks = {
  sendMessage: vi.fn(),
};

type TaskExecutorBackgroundMocks = {
  createRunningTaskRun: MockWithReset;
  recordTaskRunProgressByRunId: MockWithReset;
  completeTaskRunByRunId: MockWithReset;
  failTaskRunByRunId: MockWithReset;
};

type TaskDeliveryBackgroundMocks = {
  sendMessage: MockWithReset;
};

type AnnouncementBackgroundMocks = {
  deliverSubagentAnnouncement: MockWithReset;
};

type MediaBackgroundResetMocks = {
  taskExecutorMocks: TaskExecutorBackgroundMocks;
  taskDeliveryRuntimeMocks: TaskDeliveryBackgroundMocks;
  announceDeliveryMocks: AnnouncementBackgroundMocks;
};

type QueuedTaskExpectation = {
  taskExecutorMocks: TaskExecutorBackgroundMocks;
  taskKind: string;
  sourceId: string;
  progressSummary: string;
};

type ProgressExpectation = {
  taskExecutorMocks: TaskExecutorBackgroundMocks;
  runId: string;
  progressSummary: string;
};

type DirectSendExpectation = {
  sendMessageMock: unknown;
  channel: string;
  to: string;
  threadId: string;
  content: string;
  mediaUrls: string[];
};

type FallbackAnnouncementExpectation = {
  deliverAnnouncementMock: unknown;
  requesterSessionKey: string;
  channel: string;
  to: string;
  source: string;
  announceType: string;
  resultMediaPath: string;
  mediaUrls: string[];
};

type CompletionFixtureParams = {
  directSend?: boolean;
  mediaUrls?: string[];
  result: string;
  runId: string;
  taskLabel: string;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireMockFirstParam(mock: unknown, label: string): Record<string, unknown> {
  const first = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[0]?.[0];
  return requireRecord(first, label);
}

function requireRecordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value.map((entry, index) => requireRecord(entry, `${label}[${index}]`));
}

export function createMediaCompletionFixture({
  directSend,
  mediaUrls,
  result,
  runId,
  taskLabel,
}: CompletionFixtureParams) {
  return {
    ...(directSend
      ? { config: { tools: { media: { asyncCompletion: { directSend: true } } } } }
      : {}),
    handle: {
      taskId: "task-123",
      runId,
      requesterSessionKey: "agent:main:discord:direct:123",
      requesterOrigin: {
        channel: "discord",
        to: "channel:1",
        threadId: "thread-1",
      },
      taskLabel,
    },
    status: "ok" as const,
    statusLabel: "completed successfully",
    result,
    ...(mediaUrls ? { mediaUrls } : {}),
  };
}

export function resetMediaBackgroundMocks({
  taskExecutorMocks: taskExecutorMocksResult,
  taskDeliveryRuntimeMocks: taskDeliveryRuntimeMocksLocal,
  announceDeliveryMocks: announceDeliveryMocksLocal,
}: MediaBackgroundResetMocks): void {
  taskExecutorMocksResult.createRunningTaskRun.mockReset();
  taskExecutorMocksResult.recordTaskRunProgressByRunId.mockReset();
  taskExecutorMocksResult.completeTaskRunByRunId.mockReset();
  taskExecutorMocksResult.failTaskRunByRunId.mockReset();
  taskDeliveryRuntimeMocksLocal.sendMessage.mockReset();
  taskDeliveryRuntimeMocksLocal.sendMessage.mockResolvedValue?.({
    channel: "discord",
    to: "channel:1",
    via: "direct",
    mediaUrl: null,
    result: { messageId: "msg-1" },
  });
  announceDeliveryMocksLocal.deliverSubagentAnnouncement.mockReset();
}

export function expectQueuedTaskRun({
  taskExecutorMocks: taskExecutorMocksValue,
  taskKind,
  sourceId,
  progressSummary,
}: QueuedTaskExpectation): void {
  const params = requireMockFirstParam(
    taskExecutorMocksValue.createRunningTaskRun,
    "createRunningTaskRun params",
  );
  expect(params.taskKind).toBe(taskKind);
  expect(params.sourceId).toBe(sourceId);
  expect(params.progressSummary).toBe(progressSummary);
}

export function expectRecordedTaskProgress({
  taskExecutorMocks: taskExecutorMocksLocal,
  runId,
  progressSummary,
}: ProgressExpectation): void {
  const params = requireMockFirstParam(
    taskExecutorMocksLocal.recordTaskRunProgressByRunId,
    "recordTaskRunProgressByRunId params",
  );
  expect(params.runId).toBe(runId);
  expect(params.progressSummary).toBe(progressSummary);
}

export function expectDirectMediaSend({
  sendMessageMock,
  channel,
  to,
  threadId,
  content,
  mediaUrls,
}: DirectSendExpectation): void {
  const params = requireMockFirstParam(sendMessageMock, "sendMessage params");
  expect(params.channel).toBe(channel);
  expect(params.to).toBe(to);
  expect(params.threadId).toBe(threadId);
  expect(params.content).toBe(content);
  expect(params.mediaUrls).toEqual(mediaUrls);
}

export function expectFallbackMediaAnnouncement({
  deliverAnnouncementMock,
  requesterSessionKey,
  channel,
  to,
  source,
  announceType,
  resultMediaPath,
  mediaUrls,
}: FallbackAnnouncementExpectation): void {
  // Fallback announcements are agent-mediated completions: internal events must
  // carry media URLs and a visible-reply instruction for the completion agent.
  expect(deliverAnnouncementMock).toHaveBeenCalledTimes(1);
  const params = requireMockFirstParam(
    deliverAnnouncementMock,
    "deliverSubagentAnnouncement params",
  );
  expect(params.requesterSessionKey).toBe(requesterSessionKey);
  const requesterOrigin = requireRecord(params.requesterOrigin, "requesterOrigin");
  expect(requesterOrigin.channel).toBe(channel);
  expect(requesterOrigin.to).toBe(to);
  expect(params.expectsCompletionMessage).toBe(true);

  const event = requireRecordArray(params.internalEvents, "internalEvents").find(
    (candidate) => candidate.source === source && candidate.announceType === announceType,
  );
  if (!event) {
    throw new Error(`expected internal event ${source}/${announceType}`);
  }
  expect(event.status).toBe("ok");
  expect(String(event.result)).toContain(resultMediaPath);
  expect(event.mediaUrls).toEqual(mediaUrls);
  expect(String(event.replyInstruction)).toContain("visible-reply contract");
}

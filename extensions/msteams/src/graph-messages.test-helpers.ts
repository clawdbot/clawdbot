import { beforeEach, vi } from "vitest";

const graphMessagesMockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
  fetchGraphAbsoluteUrl: vi.fn(),
  postGraphJson: vi.fn(),
  postGraphBetaJson: vi.fn(),
  deleteGraphRequest: vi.fn(),
  findPreferredDmByUserId: vi.fn(),
}));

vi.mock("./graph.js", () => {
  return {
    resolveGraphToken: graphMessagesMockState.resolveGraphToken,
    fetchGraphJson: graphMessagesMockState.fetchGraphJson,
    fetchGraphAbsoluteUrl: graphMessagesMockState.fetchGraphAbsoluteUrl,
    postGraphJson: graphMessagesMockState.postGraphJson,
    postGraphBetaJson: graphMessagesMockState.postGraphBetaJson,
    deleteGraphRequest: graphMessagesMockState.deleteGraphRequest,
    escapeOData: vi.fn((value: string) => value.replaceAll("'", "''")),
  };
});

vi.mock("./conversation-store-fs.js", () => ({
  createMSTeamsConversationStoreFs: () => ({
    findPreferredDmByUserId: graphMessagesMockState.findPreferredDmByUserId,
  }),
}));

export const TOKEN = "test-graph-token";
export const CHAT_ID = "19:abc@thread.tacv2";
export const CHANNEL_TO = "team-id-1/channel-id-1";

export function getGraphMessagesMockState(): typeof graphMessagesMockState {
  return graphMessagesMockState;
}

export type GraphMessagesTestModule = typeof import("./graph-messages.js");

export function loadGraphMessagesTestModule(): Promise<GraphMessagesTestModule> {
  return import("./graph-messages.js");
}

export function installGraphMessagesMockDefaults(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    graphMessagesMockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });
}

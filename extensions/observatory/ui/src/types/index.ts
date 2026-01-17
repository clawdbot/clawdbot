// Agent types
export interface Agent {
  id: string
  name: string
  model: {
    primary: string
    [key: string]: unknown
  }
  workspace: string
  isDefault: boolean
  bindings: AgentBinding[]
}

export interface AgentBinding {
  channel: string
  accountId?: string
  groupId?: string
}

// Channel types
export interface ChannelAccount {
  enabled?: boolean
  groups?: Record<string, { name?: string }>
  boundAgentId?: string
  [key: string]: unknown
}

export interface ChannelConfig {
  accounts: Record<string, ChannelAccount>
}

export interface ChannelsResponse {
  channels: Record<string, ChannelConfig>
}

// Session types
export interface Session {
  agentId: string
  sessionKey: string
  sessionId: string
  updatedAt: number
}

// Message types
export interface Message {
  role: "user" | "assistant" | "system" | "tool"
  content: string | MessageContent[]
  timestamp?: number
  name?: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
  usage?: MessageUsage
  cost?: number
  duration?: number
}

export interface MessageContent {
  type: "text" | "image" | "tool_use" | "tool_result"
  text?: string
  id?: string
  name?: string
  input?: unknown
  content?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export interface MessageUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// Sub-agent run types
export interface SubAgentRun {
  runId: string
  requesterSessionKey: string
  childSessionKey: string
  task: string
  outcome?: {
    success: boolean
    result?: string
    error?: string
  }
  startedAt?: number
  completedAt?: number
}

export interface RunsResponse {
  version: number
  runs: Record<string, SubAgentRun>
}

// Log event types
export interface LogEvent {
  timestamp: string
  level: string
  message: string
  context?: Record<string, unknown>
}

// Stats types
export interface AgentStats {
  sessions: number
  messages: number
  cost: number
  tokens: number
}

export interface Stats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  byAgent: Record<string, AgentStats>
  recentCost24h: number
  recentMessages24h: number
}

// API response types
export interface AgentsResponse {
  agents: Agent[]
}

export interface SessionsResponse {
  sessions: Session[]
}

export interface TranscriptResponse {
  messages: Message[]
}

export interface StatsResponse {
  stats: Stats
}

import type {
  AgentsResponse,
  ChannelsResponse,
  SessionsResponse,
  TranscriptResponse,
  RunsResponse,
  StatsResponse,
} from "@/types"

const API_BASE = "/observatory/api"

async function fetchApi<T>(endpoint: string): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`)
  if (!response.ok) {
    throw new Error(`API error: ${response.statusText}`)
  }
  return response.json()
}

export async function getAgents(): Promise<AgentsResponse> {
  return fetchApi<AgentsResponse>("/agents")
}

export async function getChannels(): Promise<ChannelsResponse> {
  return fetchApi<ChannelsResponse>("/channels")
}

export async function getSessions(): Promise<SessionsResponse> {
  return fetchApi<SessionsResponse>("/sessions")
}

export async function getTranscript(
  agentId: string,
  sessionId: string
): Promise<TranscriptResponse> {
  return fetchApi<TranscriptResponse>(
    `/transcript?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`
  )
}

export async function getRuns(): Promise<RunsResponse> {
  return fetchApi<RunsResponse>("/runs")
}

export async function getStats(): Promise<StatsResponse> {
  return fetchApi<StatsResponse>("/stats")
}

export async function getConfig(): Promise<Record<string, unknown>> {
  return fetchApi<Record<string, unknown>>("/config")
}

// SSE connection for live events
export function subscribeToEvents(
  onEvent: (event: string) => void,
  onError?: (error: Event) => void
): () => void {
  const eventSource = new EventSource("/observatory/events")

  eventSource.onmessage = (event) => {
    onEvent(event.data)
  }

  eventSource.onerror = (error) => {
    onError?.(error)
  }

  return () => eventSource.close()
}

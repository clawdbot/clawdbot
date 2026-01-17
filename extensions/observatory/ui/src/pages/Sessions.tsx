import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { formatDistanceToNow, format } from "date-fns"
import { Search, ExternalLink, User } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { getSessions, getAgents } from "@/api/observatory"
import { getAgentEmoji, cn } from "@/lib/utils"

export function Sessions() {
  const navigate = useNavigate()
  const [search, setSearch] = useState("")
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

  const { data: sessionsData, isLoading: sessionsLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: getSessions,
    refetchInterval: 5000,
  })

  const { data: agentsData } = useQuery({
    queryKey: ["agents"],
    queryFn: getAgents,
  })

  const sessions = sessionsData?.sessions || []
  const agents = agentsData?.agents || []

  // Filter sessions
  const filteredSessions = sessions.filter((session) => {
    const matchesSearch =
      !search ||
      session.sessionKey.toLowerCase().includes(search.toLowerCase()) ||
      session.agentId.toLowerCase().includes(search.toLowerCase())
    const matchesAgent = !selectedAgent || session.agentId === selectedAgent
    return matchesSearch && matchesAgent
  })

  // Group sessions by date
  const sessionsByDate = filteredSessions.reduce(
    (acc, session) => {
      const date = format(new Date(session.updatedAt), "yyyy-MM-dd")
      if (!acc[date]) {
        acc[date] = []
      }
      acc[date].push(session)
      return acc
    },
    {} as Record<string, typeof sessions>
  )

  const openSession = (agentId: string, sessionId: string) => {
    navigate(`/sessions/${agentId}/${sessionId}`)
  }

  // Parse session key to extract useful info
  const parseSessionKey = (key: string) => {
    const parts = key.split(":")
    if (parts[0] === "agent" && parts.length >= 3) {
      return {
        type: parts[2] === "subagent" ? "subagent" : "main",
        channel: parts[2] !== "subagent" ? parts[2] : undefined,
        context: parts.slice(3).join(":") || undefined,
      }
    }
    return { type: "unknown" }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Sessions</h1>
        <p className="text-muted-foreground">
          All conversation sessions across agents
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4">
        <div className="relative flex-1 min-w-[300px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search sessions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex gap-2">
          <Button
            variant={selectedAgent === null ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedAgent(null)}
          >
            All
          </Button>
          {agents.map((agent) => (
            <Button
              key={agent.id}
              variant={selectedAgent === agent.id ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedAgent(agent.id)}
            >
              {getAgentEmoji(agent.id)} {agent.name}
            </Button>
          ))}
        </div>
      </div>

      {/* Sessions List */}
      {sessionsLoading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : (
        <ScrollArea className="h-[calc(100vh-280px)]">
          <div className="space-y-6">
            {Object.entries(sessionsByDate).map(([date, dateSessions]) => (
              <div key={date}>
                <h3 className="text-sm font-medium text-muted-foreground mb-3">
                  {format(new Date(date), "EEEE, MMMM d, yyyy")}
                </h3>
                <div className="space-y-2">
                  {dateSessions.map((session) => {
                    const parsed = parseSessionKey(session.sessionKey)
                    const isRecent =
                      Date.now() - session.updatedAt < 5 * 60 * 1000

                    return (
                      <Card
                        key={session.sessionId}
                        className={cn(
                          "cursor-pointer transition-all hover:shadow-md hover:border-primary/30",
                          isRecent && "border-l-4 border-l-green-500 bg-green-500/5"
                        )}
                        onClick={() =>
                          openSession(session.agentId, session.sessionId)
                        }
                      >
                        <CardContent className="flex items-center justify-between p-4">
                          <div className="flex items-center gap-4">
                            <div className="text-3xl flex-shrink-0">
                              {getAgentEmoji(session.agentId)}
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold">
                                  {session.agentId}
                                </span>
                                {parsed.type === "subagent" && (
                                  <Badge variant="outline" className="text-xs">
                                    subagent
                                  </Badge>
                                )}
                                {parsed.channel && (
                                  <Badge variant="secondary" className="text-xs">
                                    {parsed.channel}
                                  </Badge>
                                )}
                                {isRecent && (
                                  <Badge className="text-xs bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30">
                                    <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                                    active
                                  </Badge>
                                )}
                              </div>
                              <div className="text-sm text-muted-foreground truncate max-w-[400px] font-mono mt-1">
                                {session.sessionKey}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-4 flex-shrink-0">
                            <div className="text-right">
                              <div className="text-sm text-muted-foreground">
                                {formatDistanceToNow(
                                  new Date(session.updatedAt),
                                  { addSuffix: true }
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground font-mono">
                                {format(
                                  new Date(session.updatedAt),
                                  "HH:mm:ss"
                                )}
                              </div>
                            </div>
                            <ExternalLink className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                          </div>
                        </CardContent>
                      </Card>
                    )
                  })}
                </div>
              </div>
            ))}

            {filteredSessions.length === 0 && (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <div className="p-4 rounded-full bg-muted mb-4">
                    <User className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <p className="text-lg font-medium text-foreground">
                    {search || selectedAgent
                      ? "No sessions match your filters"
                      : "No sessions found"}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {search || selectedAgent
                      ? "Try adjusting your search or agent filter"
                      : "Sessions will appear here once agents start conversations"}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

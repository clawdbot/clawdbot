import { useQuery } from "@tanstack/react-query"
import { formatDistanceToNow } from "date-fns"
import { Link } from "react-router-dom"
import {
  Users,
  MessagesSquare,
  Activity,
  Zap,
  DollarSign,
  TrendingUp,
  Clock,
  Database,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { getAgents, getSessions, getChannels, getStats } from "@/api/observatory"
import { getAgentEmoji, getChannelIcon, formatCost, formatTokens } from "@/lib/utils"

export function Dashboard() {
  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: getAgents,
  })

  const { data: sessionsData, isLoading: sessionsLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: getSessions,
    refetchInterval: 5000,
  })

  const { data: channelsData, isLoading: channelsLoading } = useQuery({
    queryKey: ["channels"],
    queryFn: getChannels,
  })

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
    refetchInterval: 30000, // Refresh every 30s
  })

  const agents = agentsData?.agents || []
  const sessions = sessionsData?.sessions || []
  const stats = statsData?.stats
  const recentSessions = sessions.slice(0, 10)

  // Count active sessions (updated in last 5 minutes)
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
  const activeSessions = sessions.filter((s) => s.updatedAt > fiveMinutesAgo).length

  // Count channels
  const channelCounts = Object.entries(channelsData?.channels || {}).reduce(
    (acc, [channel, config]) => {
      const accountCount = Object.keys(config.accounts || {}).length
      if (accountCount > 0) {
        acc[channel] = accountCount
      }
      return acc
    },
    {} as Record<string, number>
  )

  // Get most active agents
  const activeAgents = stats?.byAgent 
    ? Object.entries(stats.byAgent)
        .sort((a, b) => b[1].messages - a[1].messages)
        .slice(0, 5)
    : []

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">
          Overview of your Clawdbot agents and activity
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="border-l-4 border-l-blue-500 hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Agents</CardTitle>
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Users className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
          </CardHeader>
          <CardContent>
            {agentsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">{agents.length}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Configured agents
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-green-500 hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Active Now</CardTitle>
            <div className="p-2 rounded-lg bg-green-500/10 animate-pulse">
              <Activity className="h-4 w-4 text-green-600 dark:text-green-400" />
            </div>
          </CardHeader>
          <CardContent>
            {sessionsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-3xl font-bold text-green-600 dark:text-green-400">{activeSessions}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Last 5 minutes
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-purple-500 hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Sessions</CardTitle>
            <div className="p-2 rounded-lg bg-purple-500/10">
              <MessagesSquare className="h-4 w-4 text-purple-600 dark:text-purple-400" />
            </div>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-3xl font-bold text-purple-600 dark:text-purple-400">{stats?.totalSessions || 0}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {stats?.totalMessages || 0} messages
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="border-l-4 border-l-orange-500 hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
            <div className="p-2 rounded-lg bg-orange-500/10">
              <DollarSign className="h-4 w-4 text-orange-600 dark:text-orange-400" />
            </div>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-3xl font-bold text-orange-600 dark:text-orange-400 font-mono">{formatCost(stats?.totalCost || 0)}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatTokens(stats?.totalTokens || 0)} tokens
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">24h Activity</CardTitle>
            <TrendingUp className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <>
                <div className="text-xl font-bold">{stats?.recentMessages24h || 0} messages</div>
                <p className="text-xs text-muted-foreground">
                  {formatCost(stats?.recentCost24h || 0)} spent
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Cache Performance</CardTitle>
            <Database className="h-4 w-4 text-purple-500" />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-8 w-24" />
            ) : (
              <>
                <div className="text-xl font-bold">{formatTokens(stats?.cacheReadTokens || 0)} read</div>
                <p className="text-xs text-muted-foreground">
                  {formatTokens(stats?.cacheWriteTokens || 0)} written
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Channels</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {channelsLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <>
                <div className="text-xl font-bold">
                  {Object.keys(channelCounts).length} platforms
                </div>
                <p className="text-xs text-muted-foreground">
                  {Object.values(channelCounts).reduce((a, b) => a + b, 0)} accounts
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Most Active Agents */}
        <Card>
          <CardHeader>
            <CardTitle>Most Active Agents</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading || agentsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {activeAgents.map(([agentId, agentStats]) => {
                  const agent = agents.find(a => a.id === agentId)
                  return (
                    <div
                      key={agentId}
                      className="flex items-center justify-between rounded-lg border p-4 hover:bg-muted/50 hover:border-primary/30 transition-all hover:shadow-sm"
                    >
                      <div className="flex items-center gap-4">
                        <div className="text-3xl">{getAgentEmoji(agentId)}</div>
                        <div>
                          <div className="font-semibold">{agent?.name || agentId}</div>
                          <div className="text-xs text-muted-foreground">
                            {agentStats.sessions} sessions · {agentStats.messages} messages
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm font-semibold text-green-600 dark:text-green-400">{formatCost(agentStats.cost)}</div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {formatTokens(agentStats.tokens)} tokens
                        </div>
                      </div>
                    </div>
                  )
                })}
                {activeAgents.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12">
                    <div className="p-4 rounded-full bg-muted mb-4">
                      <Users className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <p className="text-sm text-muted-foreground">No agent activity yet</p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Sessions */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Recent Activity</CardTitle>
              <Link to="/sessions">
                <Badge variant="outline" className="cursor-pointer hover:bg-muted">
                  View all →
                </Badge>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {sessionsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Skeleton key={i} className="h-12" />
                ))}
              </div>
            ) : (
              <ScrollArea className="h-[400px]">
                <div className="space-y-2">
                  {recentSessions.map((session) => (
                    <Link
                      key={session.sessionId}
                      to={`/sessions/${session.agentId}/${session.sessionId}`}
                      className="flex items-center justify-between rounded-lg border p-3 text-sm hover:bg-muted/50 hover:border-primary/30 transition-all hover:shadow-sm"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xl flex-shrink-0">{getAgentEmoji(session.agentId)}</span>
                        <div className="min-w-0">
                          <div className="font-medium">{session.agentId}</div>
                          <div className="text-xs text-muted-foreground truncate max-w-[200px] font-mono">
                            {session.sessionKey}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        <span className="font-mono">
                          {formatDistanceToNow(new Date(session.updatedAt), {
                            addSuffix: true,
                          })}
                        </span>
                      </div>
                    </Link>
                  ))}
                  {recentSessions.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-12">
                      <div className="p-4 rounded-full bg-muted mb-4">
                        <MessagesSquare className="h-8 w-8 text-muted-foreground" />
                      </div>
                      <p className="text-sm text-muted-foreground">No recent sessions</p>
                    </div>
                  )}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Channels Overview */}
      <Card>
        <CardHeader>
          <CardTitle>Connected Channels</CardTitle>
        </CardHeader>
        <CardContent>
          {channelsLoading ? (
            <div className="flex gap-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20 w-32" />
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-4">
              {Object.entries(channelCounts).map(([channel, count]) => (
                <div
                  key={channel}
                  className="flex items-center gap-3 rounded-lg border p-4 hover:bg-muted/50 transition-colors"
                >
                  <span className="text-2xl">{getChannelIcon(channel)}</span>
                  <div>
                    <div className="font-medium capitalize">{channel}</div>
                    <div className="text-sm text-muted-foreground">
                      {count} account{count !== 1 ? "s" : ""}
                    </div>
                  </div>
                </div>
              ))}
              {Object.keys(channelCounts).length === 0 && (
                <div className="text-muted-foreground">No channels configured</div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, Users, MessageCircle } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { getChannels, getAgents } from "@/api/observatory"
import { getChannelIcon, getAgentEmoji } from "@/lib/utils"
import { cn } from "@/lib/utils"

export function Channels() {
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set())
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set())

  const { data: channelsData, isLoading: channelsLoading } = useQuery({
    queryKey: ["channels"],
    queryFn: getChannels,
  })

  const { data: agentsData } = useQuery({
    queryKey: ["agents"],
    queryFn: getAgents,
  })

  const toggleChannel = (channel: string) => {
    const next = new Set(expandedChannels)
    if (next.has(channel)) {
      next.delete(channel)
    } else {
      next.add(channel)
    }
    setExpandedChannels(next)
  }

  const toggleAccount = (key: string) => {
    const next = new Set(expandedAccounts)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
    }
    setExpandedAccounts(next)
  }

  const channels = channelsData?.channels || {}
  const agents = agentsData?.agents || []

  const getAgentName = (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId)
    return agent?.name || agentId
  }

  if (channelsLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Channels</h1>
          <p className="text-muted-foreground">
            Connected messaging platforms and groups
          </p>
        </div>
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Channels</h1>
        <p className="text-muted-foreground">
          Connected messaging platforms and groups
        </p>
      </div>

      <div className="space-y-4">
        {Object.entries(channels).map(([channelName, channelConfig]) => {
          const accounts = channelConfig.accounts || {}
          const accountCount = Object.keys(accounts).length
          const isExpanded = expandedChannels.has(channelName)

          return (
            <Card key={channelName}>
              <CardHeader className="pb-3">
                <button
                  onClick={() => toggleChannel(channelName)}
                  className="flex w-full items-center justify-between"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{getChannelIcon(channelName)}</span>
                    <div className="text-left">
                      <CardTitle className="capitalize">{channelName}</CardTitle>
                      <p className="text-sm text-muted-foreground">
                        {accountCount} account{accountCount !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>
                  <ChevronRight
                    className={cn(
                      "h-5 w-5 text-muted-foreground transition-transform",
                      isExpanded && "rotate-90"
                    )}
                  />
                </button>
              </CardHeader>

              {isExpanded && (
                <CardContent>
                  <div className="space-y-4">
                    {Object.entries(accounts).map(([accountId, accountConfig]) => {
                      const groups = accountConfig.groups || {}
                      const groupCount = Object.keys(groups).length
                      const accountKey = `${channelName}:${accountId}`
                      const isAccountExpanded = expandedAccounts.has(accountKey)
                      const boundAgent = accountConfig.boundAgentId

                      return (
                        <div
                          key={accountId}
                          className="rounded-lg border"
                        >
                          <button
                            onClick={() => toggleAccount(accountKey)}
                            className="flex w-full items-center justify-between p-4"
                          >
                            <div className="flex items-center gap-3">
                              <Users className="h-5 w-5 text-muted-foreground" />
                              <div className="text-left">
                                <div className="font-medium">{accountId}</div>
                                <div className="text-sm text-muted-foreground">
                                  {groupCount} group{groupCount !== 1 ? "s" : ""}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {boundAgent && (
                                <Badge variant="secondary">
                                  {getAgentEmoji(boundAgent)} {getAgentName(boundAgent)}
                                </Badge>
                              )}
                              {accountConfig.enabled === false && (
                                <Badge variant="outline">disabled</Badge>
                              )}
                              <ChevronRight
                                className={cn(
                                  "h-4 w-4 text-muted-foreground transition-transform",
                                  isAccountExpanded && "rotate-90"
                                )}
                              />
                            </div>
                          </button>

                          {isAccountExpanded && groupCount > 0 && (
                            <div className="border-t">
                              <ScrollArea className="max-h-[300px]">
                                <div className="p-4 space-y-2">
                                  {Object.entries(groups).map(([groupId, groupConfig]) => (
                                    <div
                                      key={groupId}
                                      className="flex items-center justify-between rounded-md bg-muted/50 p-3"
                                    >
                                      <div className="flex items-center gap-2">
                                        <MessageCircle className="h-4 w-4 text-muted-foreground" />
                                        <div>
                                          <div className="font-medium text-sm">
                                            {groupConfig.name || "Unnamed Group"}
                                          </div>
                                          <div className="text-xs text-muted-foreground font-mono truncate max-w-[300px]">
                                            {groupId}
                                          </div>
                                        </div>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </ScrollArea>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              )}
            </Card>
          )
        })}

        {Object.keys(channels).length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <MessageCircle className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No channels configured</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

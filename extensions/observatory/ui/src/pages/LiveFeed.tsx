import { useEffect, useRef, useState } from "react"
import { format } from "date-fns"
import { Play, Pause, Trash2, Download, Filter, ChevronDown, ChevronRight, Radio } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { subscribeToEvents } from "@/api/observatory"
import { cn } from "@/lib/utils"

interface LogEntry {
  id: number
  raw: string
  timestamp: Date
  level?: string
  message?: string
  parsed?: Record<string, unknown>
  agentId?: string
  sessionId?: string
}

let eventId = 0

export function LiveFeed() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState("")
  const [levelFilter, setLevelFilter] = useState<string | null>(null)
  const [events, setEvents] = useState<LogEntry[]>([])
  const [isPaused, setIsPaused] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  useEffect(() => {
    const unsubscribe = subscribeToEvents(
      (data) => {
        if (isPaused) return

        let parsed: Record<string, unknown> | undefined
        let level: string | undefined
        let message: string | undefined
        let agentId: string | undefined
        let sessionId: string | undefined

        try {
          parsed = JSON.parse(data)
          if (typeof parsed === "object" && parsed !== null) {
            level = (parsed.level as string) || (parsed.type as string)
            message = (parsed.message as string) || (parsed.msg as string)
            
            // Extract agent/session from context
            const context = parsed.context as Record<string, unknown> | undefined
            if (context) {
              agentId = context.agentId as string
              sessionId = context.sessionId as string
            }
            
            // Try to extract from message
            if (!agentId && message) {
              const agentMatch = message.match(/agent:(\w+)/i)
              if (agentMatch) agentId = agentMatch[1]
            }
          }
        } catch {
          // Not JSON, just raw text
          message = data
        }

        const entry: LogEntry = {
          id: ++eventId,
          raw: data,
          timestamp: new Date(),
          level,
          message,
          parsed,
          agentId,
          sessionId,
        }

        setEvents((prev) => [entry, ...prev].slice(0, 1000))
        setIsConnected(true)
      },
      () => {
        setIsConnected(false)
      }
    )

    return () => unsubscribe()
  }, [isPaused])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
  }, [events])

  const filteredEvents = events.filter((event) => {
    if (levelFilter && event.level?.toLowerCase() !== levelFilter.toLowerCase()) {
      return false
    }
    if (!filter) return true
    const searchLower = filter.toLowerCase()
    return (
      event.raw.toLowerCase().includes(searchLower) ||
      event.message?.toLowerCase().includes(searchLower) ||
      event.level?.toLowerCase().includes(searchLower) ||
      event.agentId?.toLowerCase().includes(searchLower)
    )
  })

  const clearEvents = () => setEvents([])

  const downloadEvents = () => {
    const content = events.map((e) => e.raw).join("\n")
    const blob = new Blob([content], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `clawdbot-logs-${format(new Date(), "yyyy-MM-dd-HHmmss")}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const getLevelColor = (level?: string) => {
    if (!level) return "text-muted-foreground"
    const l = level.toLowerCase()
    if (l === "error" || l === "fatal") return "text-red-600 dark:text-red-400"
    if (l === "warn" || l === "warning") return "text-yellow-600 dark:text-yellow-400"
    if (l === "info") return "text-blue-600 dark:text-blue-400"
    if (l === "debug") return "text-gray-600 dark:text-gray-400"
    if (l === "system") return "text-purple-600 dark:text-purple-400"
    return "text-muted-foreground"
  }

  const getLevelBg = (level?: string) => {
    if (!level) return "bg-transparent"
    const l = level.toLowerCase()
    if (l === "error" || l === "fatal") return "bg-red-500/10 border-red-500/30"
    if (l === "warn" || l === "warning") return "bg-yellow-500/10 border-yellow-500/30"
    if (l === "info") return "bg-blue-500/10 border-blue-500/30"
    if (l === "debug") return "bg-gray-500/10 border-gray-500/30"
    if (l === "system") return "bg-purple-500/10 border-purple-500/30"
    return "bg-transparent"
  }

  // Count by level
  const levelCounts = events.reduce((acc, e) => {
    const level = e.level?.toLowerCase() || "other"
    acc[level] = (acc[level] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Live Feed</h1>
          <p className="text-muted-foreground">
            Real-time log stream from Clawdbot
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge 
            variant="outline" 
            className={cn(
              "font-medium",
              isConnected 
                ? "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/50" 
                : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/50"
            )}
          >
            <span className={cn("mr-1.5 inline-block h-2 w-2 rounded-full", isConnected ? "bg-green-500 animate-pulse" : "bg-red-500")} />
            {isConnected ? "Live" : "Disconnected"}
          </Badge>
          <Badge variant="outline" className="font-mono">{events.length} events</Badge>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-4">
        <div className="relative flex-1 min-w-[300px]">
          <Filter className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter logs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9 font-mono"
          />
        </div>

        <div className="flex gap-2 flex-wrap">
          {/* Level filter buttons */}
          {["error", "warn", "info", "debug"].map((level) => (
            <Button
              key={level}
              variant={levelFilter === level ? "default" : "outline"}
              size="sm"
              onClick={() => setLevelFilter(levelFilter === level ? null : level)}
              className="capitalize"
            >
              {level} {levelCounts[level] ? `(${levelCounts[level]})` : ""}
            </Button>
          ))}

          <Button
            variant={isPaused ? "default" : "outline"}
            size="sm"
            onClick={() => setIsPaused(!isPaused)}
          >
            {isPaused ? (
              <>
                <Play className="h-4 w-4 mr-2" />
                Resume
              </>
            ) : (
              <>
                <Pause className="h-4 w-4 mr-2" />
                Pause
              </>
            )}
          </Button>

          <Button variant="outline" size="sm" onClick={clearEvents}>
            <Trash2 className="h-4 w-4 mr-2" />
            Clear
          </Button>

          <Button variant="outline" size="sm" onClick={downloadEvents}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        </div>
      </div>

      {/* Log Stream */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <ScrollArea
            ref={scrollRef}
            className="h-[calc(100vh-320px)] min-h-[400px]"
          >
            <div className="font-mono text-sm">
              {filteredEvents.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div className={cn(
                    "p-4 rounded-full mb-4",
                    isPaused ? "bg-orange-500/10" : "bg-muted"
                  )}>
                    {isPaused ? (
                      <Pause className="h-8 w-8 text-orange-500" />
                    ) : events.length === 0 ? (
                      <Radio className="h-8 w-8 text-muted-foreground animate-pulse" />
                    ) : (
                      <Filter className="h-8 w-8 text-muted-foreground" />
                    )}
                  </div>
                  {isPaused ? (
                    <>
                      <p className="text-lg font-medium">Feed paused</p>
                      <p className="text-sm text-muted-foreground">Click Resume to continue</p>
                    </>
                  ) : events.length === 0 ? (
                    <>
                      <p className="text-lg font-medium">Waiting for events...</p>
                      <p className="text-sm text-muted-foreground">Logs will appear here in real-time</p>
                    </>
                  ) : (
                    <>
                      <p className="text-lg font-medium">No events match your filter</p>
                      <p className="text-sm text-muted-foreground">Try adjusting your search or level filters</p>
                    </>
                  )}
                </div>
              ) : (
                filteredEvents.map((event) => {
                  const isExpanded = expandedIds.has(event.id)
                  const hasDetails = event.parsed && Object.keys(event.parsed).length > 2
                  const isError = event.level?.toLowerCase() === "error" || event.level?.toLowerCase() === "fatal"

                  return (
                    <div
                      key={event.id}
                      className={cn(
                        "border-b transition-all",
                        isError ? "border-red-500/30 bg-red-500/5" : "border-border/50 hover:bg-muted/30"
                      )}
                    >
                      <div className="flex">
                        {/* Timestamp */}
                        <div className="w-24 shrink-0 px-3 py-2.5 text-xs text-muted-foreground border-r border-border/50 font-mono">
                          {format(event.timestamp, "HH:mm:ss.SSS")}
                        </div>

                        {/* Level */}
                        {event.level && (
                          <div
                            className={cn(
                              "w-20 shrink-0 px-3 py-2.5 text-xs font-bold uppercase border-r flex items-center justify-center",
                              getLevelColor(event.level),
                              getLevelBg(event.level)
                            )}
                          >
                            {event.level.slice(0, 5)}
                          </div>
                        )}

                        {/* Agent */}
                        {event.agentId && (
                          <div className="w-24 shrink-0 px-3 py-2.5 text-xs border-r border-border/50 flex items-center">
                            <Badge variant="outline" className="text-xs font-mono">
                              {event.agentId}
                            </Badge>
                          </div>
                        )}

                        {/* Message */}
                        <div className="flex-1 px-4 py-2.5 overflow-x-auto">
                          <div className="flex items-start justify-between gap-2">
                            <pre className={cn(
                              "whitespace-pre-wrap break-all flex-1 text-sm",
                              isError && "font-medium"
                            )}>
                              {event.message || event.raw}
                            </pre>
                            {hasDetails && (
                              <button
                                onClick={() => toggleExpand(event.id)}
                                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4" />
                                ) : (
                                  <ChevronRight className="h-4 w-4" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Expanded details */}
                      {isExpanded && event.parsed && (
                        <div className="px-4 py-3 bg-muted/50 border-t border-border/50">
                          <pre className="text-xs overflow-x-auto font-mono">
                            {JSON.stringify(event.parsed, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-red-500/20 border border-red-500" />
          <span>Error</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-yellow-500/20 border border-yellow-500" />
          <span>Warning</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-blue-500/20 border border-blue-500" />
          <span>Info</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded bg-purple-500/20 border border-purple-500" />
          <span>System</span>
        </div>
      </div>
    </div>
  )
}

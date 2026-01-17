import { useQuery } from "@tanstack/react-query"
import { formatDistanceToNow, format } from "date-fns"
import { GitBranch, CheckCircle, XCircle, Clock, ArrowRight } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { MarkdownContent } from "@/components/features/MarkdownContent"
import { getRuns } from "@/api/observatory"
import { getAgentEmoji } from "@/lib/utils"

export function Runs() {
  const { data: runsData, isLoading } = useQuery({
    queryKey: ["runs"],
    queryFn: getRuns,
    refetchInterval: 5000,
  })

  const runs = Object.values(runsData?.runs || {})

  // Sort by most recent first
  const sortedRuns = [...runs].sort((a, b) => {
    const aTime = a.completedAt || a.startedAt || 0
    const bTime = b.completedAt || b.startedAt || 0
    return bTime - aTime
  })

  // Parse session key to get agent ID
  const getAgentFromSessionKey = (key: string) => {
    const match = key.match(/^agent:([^:]+):/)
    return match ? match[1] : "unknown"
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Sub-Agent Runs</h1>
        <p className="text-muted-foreground">
          Task delegations between agents
        </p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <GitBranch className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-2xl font-bold">{runs.length}</div>
              <div className="text-xs text-muted-foreground">Total Runs</div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <CheckCircle className="h-5 w-5 text-green-500" />
            <div>
              <div className="text-2xl font-bold">
                {runs.filter((r) => r.outcome?.success).length}
              </div>
              <div className="text-xs text-muted-foreground">Successful</div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <XCircle className="h-5 w-5 text-red-500" />
            <div>
              <div className="text-2xl font-bold">
                {runs.filter((r) => r.outcome && !r.outcome.success).length}
              </div>
              <div className="text-xs text-muted-foreground">Failed</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Runs List */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : (
        <ScrollArea className="h-[calc(100vh-350px)]">
          <div className="space-y-4">
            {sortedRuns.map((run) => {
              const requesterAgent = getAgentFromSessionKey(run.requesterSessionKey)
              const childAgent = getAgentFromSessionKey(run.childSessionKey)
              const isComplete = !!run.outcome
              const isSuccess = run.outcome?.success

              return (
                <Collapsible key={run.runId}>
                  <Card>
                    <CollapsibleTrigger className="w-full">
                      <CardContent className="flex items-center justify-between p-4">
                        <div className="flex items-center gap-4">
                          {/* Agent flow */}
                          <div className="flex items-center gap-2">
                            <div className="flex items-center gap-1">
                              <span className="text-xl">
                                {getAgentEmoji(requesterAgent)}
                              </span>
                              <span className="text-sm font-medium">
                                {requesterAgent}
                              </span>
                            </div>
                            <ArrowRight className="h-4 w-4 text-muted-foreground" />
                            <div className="flex items-center gap-1">
                              <span className="text-xl">
                                {getAgentEmoji(childAgent)}
                              </span>
                              <span className="text-sm font-medium">
                                {childAgent}
                              </span>
                            </div>
                          </div>

                          {/* Status */}
                          {isComplete ? (
                            isSuccess ? (
                              <Badge variant="success">
                                <CheckCircle className="h-3 w-3 mr-1" />
                                Success
                              </Badge>
                            ) : (
                              <Badge variant="destructive">
                                <XCircle className="h-3 w-3 mr-1" />
                                Failed
                              </Badge>
                            )
                          ) : (
                            <Badge variant="warning">
                              <Clock className="h-3 w-3 mr-1" />
                              Running
                            </Badge>
                          )}
                        </div>

                        <div className="text-sm text-muted-foreground">
                          {run.completedAt ? (
                            formatDistanceToNow(new Date(run.completedAt), {
                              addSuffix: true,
                            })
                          ) : run.startedAt ? (
                            `Started ${formatDistanceToNow(new Date(run.startedAt), {
                              addSuffix: true,
                            })}`
                          ) : (
                            "Unknown time"
                          )}
                        </div>
                      </CardContent>
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                      <div className="border-t px-4 py-4 space-y-4">
                        {/* Task */}
                        <div>
                          <h4 className="text-sm font-medium mb-2">Task</h4>
                          <div className="rounded-lg bg-muted p-3 text-sm">
                            <MarkdownContent content={run.task} />
                          </div>
                        </div>

                        {/* Result */}
                        {run.outcome?.result && (
                          <div>
                            <h4 className="text-sm font-medium mb-2">Result</h4>
                            <div className="rounded-lg bg-muted p-3 text-sm">
                              <MarkdownContent content={run.outcome.result} />
                            </div>
                          </div>
                        )}

                        {/* Error */}
                        {run.outcome?.error && (
                          <div>
                            <h4 className="text-sm font-medium mb-2 text-red-500">
                              Error
                            </h4>
                            <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-500">
                              {run.outcome.error}
                            </div>
                          </div>
                        )}

                        {/* Metadata */}
                        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                          <div>
                            <span className="font-medium">Run ID:</span>{" "}
                            <code className="font-mono">{run.runId}</code>
                          </div>
                          {run.startedAt && (
                            <div>
                              <span className="font-medium">Started:</span>{" "}
                              {format(new Date(run.startedAt), "PPpp")}
                            </div>
                          )}
                          {run.completedAt && (
                            <div>
                              <span className="font-medium">Completed:</span>{" "}
                              {format(new Date(run.completedAt), "PPpp")}
                            </div>
                          )}
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              )
            })}

            {sortedRuns.length === 0 && (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <GitBranch className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-muted-foreground">No sub-agent runs yet</p>
                </CardContent>
              </Card>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

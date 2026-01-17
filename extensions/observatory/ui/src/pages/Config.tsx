import { useQuery } from "@tanstack/react-query"
import { RefreshCw, Settings, Copy, Check } from "lucide-react"
import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { JsonViewer } from "@/components/features/JsonViewer"
import { getConfig } from "@/api/observatory"

export function Config() {
  const [copied, setCopied] = useState(false)
  const [activeTab, setActiveTab] = useState("full")

  const { data: config, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
  })

  const copyConfig = () => {
    navigator.clipboard.writeText(JSON.stringify(config, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Extract sections from config
  const sections = config
    ? {
        agents: config.agents,
        bindings: config.bindings,
        channels: config.channels,
        plugins: config.plugins,
        session: config.session,
        logging: config.logging,
        other: Object.fromEntries(
          Object.entries(config).filter(
            ([key]) =>
              !["agents", "bindings", "channels", "plugins", "session", "logging"].includes(
                key
              )
          )
        ),
      }
    : {}

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Configuration</h1>
          <p className="text-muted-foreground">
            Current runtime configuration (secrets redacted)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isRefetching}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${isRefetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={copyConfig}>
            {copied ? (
              <>
                <Check className="h-4 w-4 mr-2 text-green-500" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-4 w-4 mr-2" />
                Copy
              </>
            )}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-[600px]" />
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="full">Full Config</TabsTrigger>
            <TabsTrigger value="agents">Agents</TabsTrigger>
            <TabsTrigger value="bindings">Bindings</TabsTrigger>
            <TabsTrigger value="channels">Channels</TabsTrigger>
            <TabsTrigger value="plugins">Plugins</TabsTrigger>
            <TabsTrigger value="session">Session</TabsTrigger>
          </TabsList>

          <TabsContent value="full">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Settings className="h-5 w-5" />
                  Full Configuration
                </CardTitle>
              </CardHeader>
              <CardContent>
                <JsonViewer data={config} initialExpanded={false} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="agents">
            <Card>
              <CardHeader>
                <CardTitle>Agents Configuration</CardTitle>
              </CardHeader>
              <CardContent>
                {sections.agents ? (
                  <JsonViewer data={sections.agents} initialExpanded={true} />
                ) : (
                  <p className="text-muted-foreground">No agents configured</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="bindings">
            <Card>
              <CardHeader>
                <CardTitle>Bindings Configuration</CardTitle>
              </CardHeader>
              <CardContent>
                {sections.bindings ? (
                  <JsonViewer data={sections.bindings} initialExpanded={true} />
                ) : (
                  <p className="text-muted-foreground">No bindings configured</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="channels">
            <Card>
              <CardHeader>
                <CardTitle>Channels Configuration</CardTitle>
              </CardHeader>
              <CardContent>
                {sections.channels ? (
                  <JsonViewer data={sections.channels} initialExpanded={true} />
                ) : (
                  <p className="text-muted-foreground">No channels configured</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="plugins">
            <Card>
              <CardHeader>
                <CardTitle>Plugins Configuration</CardTitle>
              </CardHeader>
              <CardContent>
                {sections.plugins ? (
                  <JsonViewer data={sections.plugins} initialExpanded={true} />
                ) : (
                  <p className="text-muted-foreground">No plugins configured</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="session">
            <Card>
              <CardHeader>
                <CardTitle>Session Configuration</CardTitle>
              </CardHeader>
              <CardContent>
                {sections.session ? (
                  <JsonViewer data={sections.session} initialExpanded={true} />
                ) : (
                  <p className="text-muted-foreground">
                    No session config found
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {/* Info */}
      <Card>
        <CardContent className="flex items-start gap-3 p-4">
          <Badge variant="info">Note</Badge>
          <p className="text-sm text-muted-foreground">
            Sensitive values like API keys and tokens are automatically redacted
            from this view. The configuration shown here reflects the current
            runtime state of Clawdbot.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

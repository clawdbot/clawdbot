import { useState } from "react"
import { format } from "date-fns"
import { User, Bot, Wrench, Settings, ChevronDown, ChevronRight, Zap, Clock, Coins } from "lucide-react"
import { cn, formatCost, formatTokens, formatDuration } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { MarkdownContent } from "./MarkdownContent"
import { JsonViewer } from "./JsonViewer"
import type { Message, MessageContent } from "@/types"

interface MessageBubbleProps {
  message: Message
  className?: string
}

export function MessageBubble({ message, className }: MessageBubbleProps) {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())

  const isUser = message.role === "user"
  const isAssistant = message.role === "assistant"
  const isTool = message.role === "tool"
  const isSystem = message.role === "system"

  const Icon = isUser ? User : isAssistant ? Bot : isTool ? Wrench : Settings

  const getContent = (): string => {
    if (typeof message.content === "string") {
      return message.content
    }
    if (Array.isArray(message.content)) {
      return message.content
        .filter((c): c is MessageContent & { type: "text" } => c.type === "text")
        .map((c) => c.text)
        .join("\n")
    }
    return ""
  }

  const getToolCalls = () => {
    if (typeof message.content === "string") return []
    if (!Array.isArray(message.content)) return []
    return message.content.filter(
      (c): c is MessageContent & { type: "tool_use" } => c.type === "tool_use"
    )
  }

  const getToolResults = () => {
    if (typeof message.content === "string") return []
    if (!Array.isArray(message.content)) return []
    return message.content.filter(
      (c): c is MessageContent & { type: "tool_result" } => c.type === "tool_result"
    )
  }

  const toggleTool = (id: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const content = getContent()
  const toolCalls = getToolCalls()
  const toolResults = getToolResults()

  // Calculate message-specific cost
  const messageCost = message.cost || 0
  const totalTokens = (message.usage?.input_tokens || 0) + (message.usage?.output_tokens || 0)

  return (
    <div
      className={cn(
        "group flex gap-4 rounded-xl p-5 transition-all hover:shadow-sm",
        isUser && "bg-gradient-to-br from-blue-500/10 to-blue-500/5 border border-blue-500/20",
        isAssistant && "bg-gradient-to-br from-muted/50 to-muted/30 border border-border/50",
        className
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-sm ring-2 ring-offset-2 ring-offset-background transition-transform group-hover:scale-105",
          isUser && "bg-gradient-to-br from-blue-500 to-blue-600 text-white ring-blue-500/20",
          isAssistant && "bg-gradient-to-br from-primary to-primary/80 text-primary-foreground ring-primary/20",
          isTool && "bg-gradient-to-br from-orange-500 to-orange-600 text-white ring-orange-500/20",
          isSystem && "bg-muted text-muted-foreground ring-muted"
        )}
      >
        <Icon className="h-5 w-5" />
      </div>

      {/* Content */}
      <div className="flex-1 space-y-4 overflow-hidden min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold capitalize text-sm">{message.role}</span>
          {message.name && (
            <Badge variant="outline" className="text-xs">
              {message.name}
            </Badge>
          )}
          {message.timestamp && (
            <span className="text-xs text-muted-foreground font-mono">
              {format(new Date(message.timestamp), "HH:mm:ss")}
            </span>
          )}
        </div>

        {/* Message content */}
        {content && (
          <div className="prose-sm max-w-none">
            <MarkdownContent content={content} />
          </div>
        )}

        {/* Tool calls */}
        {toolCalls.length > 0 && (
          <div className="space-y-3">
            {toolCalls.map((tool) => {
              const isExpanded = expandedTools.has(tool.id || "")
              return (
                <div
                  key={tool.id}
                  className="rounded-lg border-2 bg-gradient-to-br from-orange-500/10 to-orange-500/5 border-orange-500/30 overflow-hidden shadow-sm hover:shadow-md transition-all"
                >
                  <button
                    onClick={() => toggleTool(tool.id || "")}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-orange-500/10 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-1.5 rounded-md bg-orange-500/20">
                        <Wrench className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                      </div>
                      <span className="font-mono font-semibold text-sm">{tool.name}</span>
                      <Badge variant="secondary" className="text-xs">tool call</Badge>
                    </div>
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform" />
                    )}
                  </button>
                  {isExpanded && (
                    <div className="px-4 py-3 border-t border-orange-500/20 bg-orange-500/5">
                      <div className="text-xs font-medium text-orange-600 dark:text-orange-400 mb-2">Input Parameters:</div>
                      <JsonViewer data={tool.input} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Tool results */}
        {toolResults.length > 0 && (
          <div className="space-y-3">
            {toolResults.map((result, idx) => {
              const isExpanded = expandedTools.has(result.id || `result-${idx}`)
              return (
                <div
                  key={result.id || idx}
                  className="rounded-lg border-2 bg-gradient-to-br from-green-500/10 to-green-500/5 border-green-500/30 overflow-hidden shadow-sm hover:shadow-md transition-all"
                >
                  <button
                    onClick={() => toggleTool(result.id || `result-${idx}`)}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-green-500/10 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-1.5 rounded-md bg-green-500/20">
                        <Zap className="h-4 w-4 text-green-600 dark:text-green-400" />
                      </div>
                      <span className="font-mono font-semibold text-sm">Tool Result</span>
                      {result.id && (
                        <Badge variant="outline" className="text-xs font-mono">
                          {result.id.slice(0, 8)}
                        </Badge>
                      )}
                    </div>
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform" />
                    )}
                  </button>
                  {isExpanded && (
                    <div className="px-4 py-3 border-t border-green-500/20 bg-green-500/5">
                      <div className="text-xs font-medium text-green-600 dark:text-green-400 mb-2">Result:</div>
                      {typeof result.content === "string" ? (
                        <div className="prose-sm max-w-none">
                          <MarkdownContent content={result.content} />
                        </div>
                      ) : (
                        <JsonViewer data={result.content} />
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Message metadata */}
        {(message.usage || message.cost !== undefined || message.duration !== undefined) && (
          <div className="flex items-center gap-3 flex-wrap text-xs pt-3 border-t border-border/50">
            {message.usage && totalTokens > 0 && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-500/10 text-blue-700 dark:text-blue-400">
                <Coins className="h-3.5 w-3.5" />
                <span className="font-mono font-medium">
                  {formatTokens(totalTokens)}
                </span>
                {message.usage.input_tokens && message.usage.output_tokens && (
                  <span className="text-[10px] opacity-70">
                    {formatTokens(message.usage.input_tokens)}↓ {formatTokens(message.usage.output_tokens)}↑
                  </span>
                )}
              </div>
            )}
            {message.usage?.cache_read_input_tokens && message.usage.cache_read_input_tokens > 0 && (
              <Badge variant="outline" className="text-[11px] h-6 border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400">
                ⚡ {formatTokens(message.usage.cache_read_input_tokens)} cached
              </Badge>
            )}
            {messageCost > 0 && (
              <Badge variant="secondary" className="text-[11px] h-6 font-mono font-semibold bg-green-500/10 text-green-700 dark:text-green-400">
                💰 {formatCost(messageCost)}
              </Badge>
            )}
            {message.duration !== undefined && (
              <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-orange-500/10 text-orange-700 dark:text-orange-400">
                <Clock className="h-3.5 w-3.5" />
                <span className="font-mono font-medium">{formatDuration(message.duration)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

import { useState } from "react"
import { ChevronRight, Copy, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface JsonViewerProps {
  data: unknown
  className?: string
  initialExpanded?: boolean
}

export function JsonViewer({ data, className, initialExpanded = false }: JsonViewerProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={cn("relative rounded-lg bg-muted p-4", className)}>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 h-6 w-6"
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </Button>
      <pre className="overflow-x-auto text-sm font-mono">
        <JsonNode data={data} depth={0} initialExpanded={initialExpanded} />
      </pre>
    </div>
  )
}

interface JsonNodeProps {
  data: unknown
  depth: number
  initialExpanded: boolean
}

function JsonNode({ data, depth, initialExpanded }: JsonNodeProps) {
  const [expanded, setExpanded] = useState(initialExpanded || depth < 2)

  if (data === null) {
    return <span className="text-orange-500 dark:text-orange-400">null</span>
  }

  if (typeof data === "boolean") {
    return (
      <span className="text-blue-600 dark:text-blue-400">
        {data.toString()}
      </span>
    )
  }

  if (typeof data === "number") {
    return (
      <span className="text-green-600 dark:text-green-400">{data}</span>
    )
  }

  if (typeof data === "string") {
    // Truncate long strings
    const displayString = data.length > 200 ? `${data.slice(0, 200)}...` : data
    return (
      <span className="text-amber-600 dark:text-amber-400">
        "{displayString}"
      </span>
    )
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span className="text-muted-foreground">[]</span>
    }

    return (
      <span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center hover:text-primary"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 transition-transform",
              expanded && "rotate-90"
            )}
          />
          <span className="text-muted-foreground">[{data.length}]</span>
        </button>
        {expanded && (
          <span className="block pl-4">
            {data.map((item, index) => (
              <span key={index} className="block">
                <span className="text-muted-foreground">{index}: </span>
                <JsonNode data={item} depth={depth + 1} initialExpanded={initialExpanded} />
                {index < data.length - 1 && ","}
              </span>
            ))}
          </span>
        )}
      </span>
    )
  }

  if (typeof data === "object") {
    const entries = Object.entries(data as object)
    if (entries.length === 0) {
      return <span className="text-muted-foreground">{"{}"}</span>
    }

    return (
      <span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center hover:text-primary"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 transition-transform",
              expanded && "rotate-90"
            )}
          />
          <span className="text-muted-foreground">
            {"{"}
            {entries.length}
            {"}"}
          </span>
        </button>
        {expanded && (
          <span className="block pl-4">
            {entries.map(([key, value], index) => (
              <span key={key} className="block">
                <span className="text-purple-600 dark:text-purple-400">
                  "{key}"
                </span>
                <span className="text-muted-foreground">: </span>
                <JsonNode data={value} depth={depth + 1} initialExpanded={initialExpanded} />
                {index < entries.length - 1 && ","}
              </span>
            ))}
          </span>
        )}
      </span>
    )
  }

  return <span>{String(data)}</span>
}

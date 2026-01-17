import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`
  }
  return `$${cost.toFixed(2)}`
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`
  }
  return tokens.toString()
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m ${secs}s`
}

export function getChannelIcon(channel: string): string {
  const icons: Record<string, string> = {
    whatsapp: "📱",
    slack: "💬",
    discord: "🎮",
    telegram: "✈️",
    signal: "🔒",
    imessage: "💬",
  }
  return icons[channel] || "💬"
}

export function getAgentEmoji(agentId: string): string {
  const emojis: Record<string, string> = {
    kev: "🦈",
    atlas: "🗺️",
    rex: "🦖",
    forge: "🛠️",
    hawk: "🦅",
    pixel: "🎨",
    blaze: "🔥",
    echo: "🦜",
    chase: "🎯",
    ally: "🤝",
    scout: "🔍",
    dash: "📊",
    finn: "💰",
    dot: "🐝",
    law: "⚖️",
  }
  return emojis[agentId] || "🤖"
}

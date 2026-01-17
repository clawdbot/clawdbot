import { NavLink } from "react-router-dom"
import {
  LayoutDashboard,
  MessagesSquare,
  Radio,
  GitBranch,
  Settings,
  Users,
  Telescope,
} from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/channels", icon: MessagesSquare, label: "Channels" },
  { to: "/sessions", icon: Users, label: "Sessions" },
  { to: "/live", icon: Radio, label: "Live Feed" },
  { to: "/runs", icon: GitBranch, label: "Sub-Agent Runs" },
  { to: "/config", icon: Settings, label: "Config" },
]

export function Sidebar() {
  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-card">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Telescope className="h-6 w-6 text-primary" />
        <div className="flex flex-col">
          <span className="font-semibold leading-tight">Orchestrator</span>
          <span className="text-xs text-muted-foreground">Observatory</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t p-4">
        <p className="text-xs text-muted-foreground">
          Connected to Clawdbot
        </p>
      </div>
    </aside>
  )
}

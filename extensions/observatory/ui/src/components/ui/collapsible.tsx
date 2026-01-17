import * as React from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

interface CollapsibleProps extends React.HTMLAttributes<HTMLDivElement> {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
}

const Collapsible = React.forwardRef<HTMLDivElement, CollapsibleProps>(
  ({ className, open: controlledOpen, onOpenChange, defaultOpen = false, children, ...props }, ref) => {
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen)
    const isControlled = controlledOpen !== undefined
    const open = isControlled ? controlledOpen : internalOpen

    const handleToggle = () => {
      if (isControlled) {
        onOpenChange?.(!open)
      } else {
        setInternalOpen(!open)
      }
    }

    return (
      <div ref={ref} className={cn("", className)} data-state={open ? "open" : "closed"} {...props}>
        {React.Children.map(children, (child) => {
          if (React.isValidElement(child)) {
            if (child.type === CollapsibleTrigger) {
              return React.cloneElement(child as React.ReactElement<CollapsibleTriggerProps>, {
                open,
                onClick: handleToggle,
              })
            }
            if (child.type === CollapsibleContent) {
              return React.cloneElement(child as React.ReactElement<CollapsibleContentProps>, { open })
            }
          }
          return child
        })}
      </div>
    )
  }
)
Collapsible.displayName = "Collapsible"

interface CollapsibleTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  open?: boolean
}

const CollapsibleTrigger = React.forwardRef<HTMLButtonElement, CollapsibleTriggerProps>(
  ({ className, open, children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        "flex w-full items-center gap-2 py-2 text-sm font-medium transition-all hover:bg-muted/50 [&[data-state=open]>svg]:rotate-90",
        className
      )}
      data-state={open ? "open" : "closed"}
      {...props}
    >
      <ChevronRight className="h-4 w-4 shrink-0 transition-transform duration-200" />
      {children}
    </button>
  )
)
CollapsibleTrigger.displayName = "CollapsibleTrigger"

interface CollapsibleContentProps extends React.HTMLAttributes<HTMLDivElement> {
  open?: boolean
}

const CollapsibleContent = React.forwardRef<HTMLDivElement, CollapsibleContentProps>(
  ({ className, open, children, ...props }, ref) => {
    if (!open) return null

    return (
      <div
        ref={ref}
        className={cn("overflow-hidden", className)}
        {...props}
      >
        {children}
      </div>
    )
  }
)
CollapsibleContent.displayName = "CollapsibleContent"

export { Collapsible, CollapsibleTrigger, CollapsibleContent }

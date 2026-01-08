# Swift MCP Builder Skill

Build macOS CLI tools with MCP server integration using Swift 6.2+.

## When to Use

Trigger phrases:
- "Create a CLI for [Apple service]"
- "Build an MCP server for [thing]"
- "Make a Swift CLI that does [X]"
- "New tool for [Apple API]"

## Project Naming Convention

**CRITICAL**: Every project MUST have a quirky, memorable name.

### Naming Rules
1. **Never boring**: No `ContactsCLI`, `NotesTool`, `CalendarManager`
2. **Punny or playful**: Braindump, Contactbook, Vitalink, TauTUI, MCPorter
3. **Short & memorable**: 1-2 words, easy to type
4. **Lowercase binary**: The executable name should be all lowercase

### Name Generation Process
1. Identify the core function (contacts, notes, health, etc.)
2. Find wordplay, puns, or clever combinations
3. Examples:
   - Contacts → Contactbook, Rolodex, PeoplePeek, Buddy
   - Notes → Braindump, Scribble, Thoughtful, Jotter
   - Calendar → Caly, DateMate, TimeTap, Agenda
   - Health → Vitalink, PulsePal, FitBit (taken), Wellness
   - Music → Tuneful, BeatBox, SoundBite, Melody
   - Files → Finder (taken), FileFlip, DocDock, Stash

## Project Structure

```
{ProjectName}/
├── Package.swift
├── README.md
├── .gitignore
├── assets/
│   ├── logo.svg          # Simple SVG logo
│   └── icon.png          # Generated via nano-banana-pro
├── Sources/
│   ├── {ProjectName}CLI/
│   │   ├── {ProjectName}.swift      # Main entry (@main struct)
│   │   ├── Commands/
│   │   │   ├── {Domain}Command.swift   # CLI commands
│   │   │   └── MCPCommand.swift        # MCP serve & tools
│   │   ├── Services/
│   │   │   └── {Domain}Service.swift   # AppleScript/API layer
│   │   └── MCP/
│   │       └── {ProjectName}MCPServer.swift
│   └── {ProjectName}Exec/
│       └── main.swift               # Just imports and calls CLI
└── Tests/
    └── {ProjectName}Tests/
```

## Package.swift Template

```swift
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "{ProjectName}",
    platforms: [
        .macOS(.v26),
    ],
    products: [
        .executable(name: "{projectname}", targets: ["{ProjectName}Exec"]),
        .library(name: "{ProjectName}CLI", targets: ["{ProjectName}CLI"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.5.0"),
        .package(url: "https://github.com/modelcontextprotocol/swift-sdk", from: "0.9.0"),
        .package(url: "https://github.com/apple/swift-log", from: "1.6.0"),
    ],
    targets: [
        .target(
            name: "{ProjectName}CLI",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                .product(name: "MCP", package: "swift-sdk"),
                .product(name: "Logging", package: "swift-log"),
            ],
            path: "Sources/{ProjectName}CLI"
        ),
        .executableTarget(
            name: "{ProjectName}Exec",
            dependencies: ["{ProjectName}CLI"],
            path: "Sources/{ProjectName}Exec"
        ),
        .testTarget(
            name: "{ProjectName}Tests",
            dependencies: ["{ProjectName}CLI"],
            path: "Tests/{ProjectName}Tests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
```

## Main Entry Point Pattern

```swift
// Sources/{ProjectName}CLI/{ProjectName}.swift
import ArgumentParser

@main
public struct {ProjectName}: AsyncParsableCommand {
    public static let configuration = CommandConfiguration(
        commandName: "{projectname}",
        abstract: "{Short description}",
        version: "1.0.0",
        subcommands: [
            {Domain}Command.self,
            MCPCommand.self,
        ],
        defaultSubcommand: {Domain}Command.self
    )
    
    public init() {}
}
```

## Executable Entry Point

```swift
// Sources/{ProjectName}Exec/main.swift
import {ProjectName}CLI

// Entry point handled by @main in {ProjectName}
```

## MCP Server Pattern

```swift
// Sources/{ProjectName}CLI/MCP/{ProjectName}MCPServer.swift
import MCP
import Foundation
import Logging

public actor {ProjectName}MCPServer {
    private let service: {Domain}Service
    private let logger: Logger
    
    public init() {
        self.service = {Domain}Service()
        self.logger = Logger(label: "com.{username}.{projectname}.mcp")
    }
    
    public func run() async throws {
        let server = Server(
            name: "{projectname}",
            version: "1.0.0",
            capabilities: .init(tools: .init())
        )
        
        await server.withMethodHandler(ListTools.self) { _ in
            ListTools.Result(tools: self.allTools)
        }
        
        await server.withMethodHandler(CallTool.self) { params in
            try await self.handleToolCall(params)
        }
        
        let transport = StdioTransport()
        try await server.start(transport: transport)
    }
    
    private var allTools: [Tool] {
        [
            Tool(
                name: "{domain}_list",
                description: "List all {items}",
                inputSchema: .object(properties: [
                    "limit": .integer(description: "Max items to return")
                ])
            ),
            // ... more tools
        ]
    }
    
    private func handleToolCall(_ params: CallTool.Params) async throws -> CallTool.Result {
        switch params.name {
        case "{domain}_list":
            let limit = params.arguments?["limit"]?.intValue ?? 50
            let result = try await service.list(limit: limit)
            return .init(content: [.text(.init(text: result))])
        default:
            throw MCPError.methodNotFound("Unknown tool: \(params.name)")
        }
    }
}
```

## MCP Command Pattern

```swift
// Sources/{ProjectName}CLI/Commands/MCPCommand.swift
import ArgumentParser

struct MCPCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "mcp",
        abstract: "MCP server commands",
        subcommands: [Serve.self, ListMCPTools.self],  // Note: ListMCPTools to avoid SDK collision
        defaultSubcommand: Serve.self
    )
    
    struct Serve: AsyncParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "serve",
            abstract: "Start MCP server (stdio transport)"
        )
        
        mutating func run() async throws {
            let server = {ProjectName}MCPServer()
            try await server.run()
        }
    }
    
    struct ListMCPTools: ParsableCommand {  // Renamed from ListTools
        static let configuration = CommandConfiguration(
            commandName: "tools",
            abstract: "List available MCP tools"
        )
        
        func run() throws {
            print("Available MCP Tools:\n")
            // Print tool descriptions
        }
    }
}
```

## AppleScript Service Pattern

For Apple app integrations (Contacts, Notes, Reminders, Calendar):

```swift
// Sources/{ProjectName}CLI/Services/{Domain}Service.swift
import Foundation

public struct {Domain}Service {
    public init() {}
    
    public func list(limit: Int = 50) async throws -> String {
        let script = """
        tell application "{AppleApp}"
            set output to "["
            set itemList to every {item}
            set maxItems to \(limit)
            set itemCount to 0
            
            repeat with i in itemList
                if itemCount >= maxItems then exit repeat
                -- Build JSON object
                set output to output & "{...}"
                set itemCount to itemCount + 1
            end repeat
            
            set output to output & "]"
            return output
        end tell
        """
        
        return try await runAppleScript(script)
    }
    
    private func runAppleScript(_ source: String) async throws -> String {
        var error: NSDictionary?
        guard let script = NSAppleScript(source: source) else {
            throw ServiceError.scriptCreationFailed
        }
        
        let result = script.executeAndReturnError(&error)
        if let error = error {
            throw ServiceError.executionFailed(error.description)
        }
        
        return result.stringValue ?? ""
    }
}
```

## README Template

```markdown
# {ProjectName}

![{ProjectName} Logo](assets/logo.svg)

{Tagline} - {quirky one-liner description}

{ProjectName} is a macOS command-line interface (CLI) and Model Context Protocol (MCP) server for {Apple Service/Domain}. It allows you to {core functionality} directly from the terminal or through AI agents.

## Requirements

- macOS 26+ (Tahoe)
- Swift 6.2+

## Installation

### From Source

```bash
git clone https://github.com/{username}/{ProjectName}.git
cd {ProjectName}
swift build -c release
cp .build/release/{projectname} /usr/local/bin/
```

## CLI Usage

### {Primary Command}

```bash
{projectname} {command} list
{projectname} {command} search "query"
{projectname} {command} get <id>
{projectname} {command} create --field "value"
```

## MCP Server Setup

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "{projectname}": {
      "command": "{projectname}",
      "args": ["mcp", "serve"]
    }
  }
}
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `{domain}_list` | List all {items} |
| `{domain}_search` | Search {items} |
| `{domain}_get` | Get {item} by ID |
| `{domain}_create` | Create new {item} |
| `{domain}_update` | Update existing {item} |
| `{domain}_delete` | Delete {item} |

## License

MIT License
```

## Icon Generation

Use nano-banana-pro skill to generate app icon:

```bash
GEMINI_API_KEY="..." uv run /Users/cortex-mini/Developer/clawdis/skills/nano-banana-pro/scripts/generate_image.py \
  --prompt "A modern app icon for {ProjectName}: {description of what it does}, clean minimal design, {color scheme}, rounded corners, suitable for macOS/iOS app icon, professional and friendly" \
  --filename "/path/to/{ProjectName}/assets/icon.png" \
  --resolution 1K
```

## Skill File Template

Create at `/Users/cortex-mini/Developer/clawdis/skills/{projectname}/skill.md`:

```markdown
# {ProjectName} Skill

{ProjectName} is a macOS CLI & MCP server for {Apple Service}.

## Installation

```bash
cd /Users/cortex-mini/Developer/{ProjectName}
swift build -c release
cp .build/release/{projectname} /usr/local/bin/
```

## CLI Commands

### {Domain}

```bash
{projectname} {domain} list [--limit <n>] [--json]
{projectname} {domain} search <query> [--json]
{projectname} {domain} get <id> [--json]
{projectname} {domain} create --field <value>
{projectname} {domain} delete <id> [--force]
```

### MCP Server

```bash
{projectname} mcp serve    # Start MCP server (stdio transport)
{projectname} mcp tools    # List available tools
```

## MCP Configuration

Add to Claude Desktop config:

```json
{
  "mcpServers": {
    "{projectname}": {
      "command": "{projectname}",
      "args": ["mcp", "serve"]
    }
  }
}
```
```

## MCP Configuration

After building, add to both:

### Claude Desktop
`~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
"{projectname}": {
  "command": "/path/to/.build/release/{projectname}",
  "args": ["mcp", "serve"]
}
```

### OpenCode
`~/.config/opencode/opencode.json`:
```json
"{projectname}": {
  "type": "local",
  "command": ["/path/to/.build/release/{projectname}", "mcp", "serve"],
  "enabled": true,
  "environment": {}
}
```

## Build & Test Workflow

```bash
# 1. Create project directory
mkdir -p /Users/cortex-mini/Developer/{ProjectName}
cd /Users/cortex-mini/Developer/{ProjectName}

# 2. Create structure
mkdir -p Sources/{ProjectName}CLI/{Commands,Services,MCP}
mkdir -p Sources/{ProjectName}Exec
mkdir -p Tests/{ProjectName}Tests
mkdir -p assets

# 3. Create files (Package.swift, source files, etc.)

# 4. Build
swift build -c release

# 5. Test CLI
.build/release/{projectname} --help
.build/release/{projectname} {domain} list --limit 5
.build/release/{projectname} mcp tools

# 6. Generate icon
GEMINI_API_KEY="..." uv run nano-banana-pro script...

# 7. Git init & push
git init && git branch -m main
git add . && git commit -m "Initial commit"
gh repo create {username}/{ProjectName} --public --source=. --push

# 8. Create skill file
mkdir -p /Users/cortex-mini/Developer/clawdis/skills/{projectname}
# Write skill.md

# 9. Update MCP configs
```

## Reference Implementations

Study these for patterns:
- **Braindump** (`/Users/cortex-mini/Developer/Braindump/`): Notes + Reminders
- **Contactbook** (`/Users/cortex-mini/Developer/Contactbook/`): Contacts
- **Vitalink** (`/Users/cortex-mini/Developer/Vitalink/`): HealthKit
- **MCPorter** (https://github.com/steipete/mcporter): TypeScript MCP toolkit
- **TauTUI** (https://github.com/steipete/TauTUI): Swift TUI patterns
- **MCPLI** (https://github.com/cameroncooke/mcpli): CLI-first MCP approach

## Best Practices (from Reference Projects)

1. **Keep tools focused**: One tool = one action
2. **JSON output by default**: All list/get commands should have `--json` flag
3. **Sensible defaults**: Limit queries to 50 items for performance
4. **Clear error messages**: Use descriptive error enums
5. **AppleScript with JSON**: Generate JSON directly in AppleScript for clean parsing
6. **Type-safe MCP**: Use proper Tool schemas with descriptions
7. **Avoid name collisions**: Rename local types that conflict with MCP SDK (e.g., `ListMCPTools` vs `ListTools`)

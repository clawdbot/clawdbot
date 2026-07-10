import Foundation
import OSLog

enum AgentWorkspace {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "workspace")
    static let agentsFilename = "AGENTS.md"
    static let soulFilename = "SOUL.md"
    static let identityFilename = "IDENTITY.md"
    static let userFilename = "USER.md"
    static let bootstrapFilename = "BOOTSTRAP.md"
    private static let templateDirname = "templates"
    private static let ignoredEntries: Set<String> = [".DS_Store", ".git", ".gitignore"]
    private static let templateEntries: Set<String> = [
        AgentWorkspace.agentsFilename,
        AgentWorkspace.soulFilename,
        AgentWorkspace.identityFilename,
        AgentWorkspace.userFilename,
        AgentWorkspace.bootstrapFilename,
    ]
    struct BootstrapSafety: Equatable {
        let unsafeReason: String?

        static let safe = Self(unsafeReason: nil)

        static func blocked(_ reason: String) -> Self {
            Self(unsafeReason: reason)
        }
    }

    static func displayPath(for url: URL) -> String {
        let home = FileManager().homeDirectoryForCurrentUser.path
        let path = url.path
        if path == home { return "~" }
        if path.hasPrefix(home + "/") {
            return "~/" + String(path.dropFirst(home.count + 1))
        }
        return path
    }

    static func resolveWorkspaceURL(from userInput: String?) -> URL {
        let trimmed = userInput?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty { return OpenClawConfigFile.defaultWorkspaceURL() }
        let expanded = (trimmed as NSString).expandingTildeInPath
        return URL(fileURLWithPath: expanded, isDirectory: true)
    }

    static func agentsURL(workspaceURL: URL) -> URL {
        workspaceURL.appendingPathComponent(self.agentsFilename)
    }

    static func workspaceEntries(workspaceURL: URL) throws -> [String] {
        let contents = try FileManager().contentsOfDirectory(atPath: workspaceURL.path)
        return contents.filter { !self.ignoredEntries.contains($0) }
    }

    static func isWorkspaceEmpty(workspaceURL: URL) -> Bool {
        let fm = FileManager()
        var isDir: ObjCBool = false
        if !fm.fileExists(atPath: workspaceURL.path, isDirectory: &isDir) {
            return true
        }
        guard isDir.boolValue else { return false }
        guard let entries = try? self.workspaceEntries(workspaceURL: workspaceURL) else { return false }
        return entries.isEmpty
    }

    static func isTemplateOnlyWorkspace(workspaceURL: URL) -> Bool {
        guard let entries = try? self.workspaceEntries(workspaceURL: workspaceURL) else { return false }
        guard !entries.isEmpty else { return true }
        return Set(entries).isSubset(of: self.templateEntries)
    }

    static func bootstrapSafety(for workspaceURL: URL) -> BootstrapSafety {
        let fm = FileManager()
        var isDir: ObjCBool = false
        if !fm.fileExists(atPath: workspaceURL.path, isDirectory: &isDir) {
            return .safe
        }
        if !isDir.boolValue { return .blocked("Workspace path points to a file.") }
        let agentsURL = self.agentsURL(workspaceURL: workspaceURL)
        if fm.fileExists(atPath: agentsURL.path) {
            return .safe
        }
        do {
            let entries = try self.workspaceEntries(workspaceURL: workspaceURL)
            return entries.isEmpty
                ? .safe
                : .blocked("Folder isn't empty. Choose a new folder or add AGENTS.md first.")
        } catch {
            return .blocked("Couldn't inspect the workspace folder.")
        }
    }

    static func bootstrap(workspaceURL: URL) throws -> URL {
        let shouldSeedBootstrap = self.isWorkspaceEmpty(workspaceURL: workspaceURL)
        try FileManager().createDirectory(at: workspaceURL, withIntermediateDirectories: true)
        let agentsURL = self.agentsURL(workspaceURL: workspaceURL)
        if !FileManager().fileExists(atPath: agentsURL.path) {
            try self.defaultTemplate().write(to: agentsURL, atomically: true, encoding: .utf8)
            self.logger.info("Created AGENTS.md at \(agentsURL.path, privacy: .public)")
        }
        let soulURL = workspaceURL.appendingPathComponent(self.soulFilename)
        if !FileManager().fileExists(atPath: soulURL.path) {
            try self.defaultSoulTemplate().write(to: soulURL, atomically: true, encoding: .utf8)
            self.logger.info("Created SOUL.md at \(soulURL.path, privacy: .public)")
        }
        let identityURL = workspaceURL.appendingPathComponent(self.identityFilename)
        if !FileManager().fileExists(atPath: identityURL.path) {
            try self.defaultIdentityTemplate().write(to: identityURL, atomically: true, encoding: .utf8)
            self.logger.info("Created IDENTITY.md at \(identityURL.path, privacy: .public)")
        }
        let userURL = workspaceURL.appendingPathComponent(self.userFilename)
        if !FileManager().fileExists(atPath: userURL.path) {
            try self.defaultUserTemplate().write(to: userURL, atomically: true, encoding: .utf8)
            self.logger.info("Created USER.md at \(userURL.path, privacy: .public)")
        }
        let bootstrapURL = workspaceURL.appendingPathComponent(self.bootstrapFilename)
        if shouldSeedBootstrap, !FileManager().fileExists(atPath: bootstrapURL.path) {
            try self.defaultBootstrapTemplate().write(to: bootstrapURL, atomically: true, encoding: .utf8)
            self.logger.info("Created BOOTSTRAP.md at \(bootstrapURL.path, privacy: .public)")
        }
        return agentsURL
    }

    static func needsBootstrap(workspaceURL: URL) -> Bool {
        let fm = FileManager()
        var isDir: ObjCBool = false
        if !fm.fileExists(atPath: workspaceURL.path, isDirectory: &isDir) {
            return true
        }
        guard isDir.boolValue else { return true }
        if self.hasIdentity(workspaceURL: workspaceURL) {
            return false
        }
        let bootstrapURL = workspaceURL.appendingPathComponent(self.bootstrapFilename)
        guard fm.fileExists(atPath: bootstrapURL.path) else { return false }
        return self.isTemplateOnlyWorkspace(workspaceURL: workspaceURL)
    }

    static func hasIdentity(workspaceURL: URL) -> Bool {
        let identityURL = workspaceURL.appendingPathComponent(self.identityFilename)
        guard let contents = try? String(contentsOf: identityURL, encoding: .utf8) else { return false }
        return self.identityLinesHaveValues(contents)
    }

    private static func identityLinesHaveValues(_ content: String) -> Bool {
        for line in content.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.hasPrefix("-"), let colon = trimmed.firstIndex(of: ":") else { continue }
            let value = trimmed[trimmed.index(after: colon)...].trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty {
                return true
            }
        }
        return false
    }

    static func defaultTemplate() -> String {
        let fallback = """
        # AGENTS.md - OpenClaw Workspace

        This folder is the assistant's working directory.

        ## First run (one-time)
        - If BOOTSTRAP.md exists, follow its ritual and delete it once complete.
        - Your agent identity lives in IDENTITY.md.
        - Your profile lives in USER.md.

        ## Backup tip (recommended)
        If you treat this workspace as the agent's "memory", make it a git repo (ideally private) so identity
        and notes are backed up.

        ```bash
        git init
        git add AGENTS.md
        git commit -m "Add agent workspace"
        ```

        ## Safety defaults
        - Don't exfiltrate secrets or private data.
        - Don't run destructive commands unless explicitly asked.
        - Be concise in chat; write longer output to files in this workspace.

        ## Daily memory (recommended)
        - Keep a short daily log at memory/YYYY-MM-DD.md (create memory/ if needed).
        - On session start, read today + yesterday if present.
        - Capture durable facts, preferences, and decisions; avoid secrets.

        ## Customize
        - Add your preferred style, rules, and "memory" here.
        """
        return self.loadTemplate(named: self.agentsFilename, fallback: fallback)
    }

    static func defaultSoulTemplate() -> String {
        let fallback = """
        # SOUL.md - Persona & Boundaries

        Describe who the assistant is, tone, and boundaries.

        - Keep replies concise and direct.
        - Ask clarifying questions when needed.
        - Never send streaming/partial replies to external messaging surfaces.
        """
        return self.loadTemplate(named: self.soulFilename, fallback: fallback)
    }

    static func defaultIdentityTemplate() -> String {
        let fallback = """
        # IDENTITY.md - Agent Identity

        - Name:
        - Creature:
        - Vibe:
        - Emoji:
        """
        return self.loadTemplate(named: self.identityFilename, fallback: fallback)
    }

    static func defaultUserTemplate() -> String {
        let fallback = """
        # USER.md - User Profile

        - Name:
        - Preferred address:
        - Pronouns (optional):
        - Timezone (optional):
        - Notes:
        """
        return self.loadTemplate(named: self.userFilename, fallback: fallback)
    }

    static func defaultBootstrapTemplate() -> String {
        let fallback = """
        # BOOTSTRAP.md - First Run Ritual (delete after)

        Hello. I was just born.

        ## Your mission
        Start a short, playful conversation and learn:
        - Who am I?
        - What am I?
        - Who are you?
        - How should I call you?

        ## How to ask (cute + helpful)
        Say:
        "Hello! I was just born. Who am I? What am I? Who are you? How should I call you?"

        Then offer suggestions:
        - 3-5 name ideas.
        - 3-5 creature/vibe combos.
        - 5 emoji ideas.

        ## Write these files
        After the user chooses, update:

        1) IDENTITY.md
        - Name
        - Creature
        - Vibe
        - Emoji

        2) USER.md
        - Name
        - Preferred address
        - Pronouns (optional)
        - Timezone (optional)
        - Notes

        3) ~/.openclaw/openclaw.json
        Set identity.name, identity.theme, identity.emoji to match IDENTITY.md.

        ## Cleanup
        Delete BOOTSTRAP.md once this is complete.
        """
        return self.loadTemplate(named: self.bootstrapFilename, fallback: fallback)
    }

    private static func loadTemplate(named: String, fallback: String) -> String {
        for url in self.templateURLs(named: named) {
            if let content = try? String(contentsOf: url, encoding: .utf8) {
                let stripped = self.stripFrontMatter(content)
                if !stripped.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    return stripped
                }
            }
        }
        return fallback
    }

    private static func templateURLs(named: String) -> [URL] {
        var urls: [URL] = []
        if let resource = Bundle.main.url(
            forResource: named.replacingOccurrences(of: ".md", with: ""),
            withExtension: "md",
            subdirectory: self.templateDirname)
        {
            urls.append(resource)
        }
        if let resource = Bundle.main.url(
            forResource: named,
            withExtension: nil,
            subdirectory: self.templateDirname)
        {
            urls.append(resource)
        }
        if let dev = self.devTemplateURL(named: named) {
            urls.append(dev)
        }
        let cwd = URL(fileURLWithPath: FileManager().currentDirectoryPath)
        urls.append(cwd.appendingPathComponent("docs")
            .appendingPathComponent(self.templateDirname)
            .appendingPathComponent(named))
        return urls
    }

    private static func devTemplateURL(named: String) -> URL? {
        let sourceURL = URL(fileURLWithPath: #filePath)
        let repoRoot = sourceURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return repoRoot.appendingPathComponent("docs")
            .appendingPathComponent(self.templateDirname)
            .appendingPathComponent(named)
    }

    private static func stripFrontMatter(_ content: String) -> String {
        guard content.hasPrefix("---") else { return content }
        let start = content.index(content.startIndex, offsetBy: 3)
        guard let range = content.range(of: "\n---", range: start..<content.endIndex) else {
            return content
        }
        let remainder = content[range.upperBound...]
        let trimmed = remainder.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed + "\n"
    }

    // Identity is written by the agent during the bootstrap ritual.
}

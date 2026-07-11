import CoreFoundation
import Darwin
import Foundation

enum MacNodeCodexThreadCatalogContract {
    static let pluginId = "codex"
    static let capability = "codex-app-server-threads"
    static let listCommand = "codex.appServer.threads.list.v1"
}

enum MacNodeCodexThreadCatalog {
    struct ResolvedInvocation: Equatable {
        var executable: String
        var arguments: [String]
        var cwd: URL?
        var clearEnv: [String] = []
    }

    enum CatalogError: LocalizedError, Equatable {
        case invalidParams(String)
        case catalogDisabled
        case invalidAppServerConfiguration
        case codexUnavailable
        case unsupportedAppServerTransport
        case unsupportedAppServerHomeScope
        case appServerUnavailable
        case responseTooLarge
        case timedOut

        var errorDescription: String? {
            switch self {
            case let .invalidParams(message):
                "INVALID_REQUEST: \(message)"
            case .catalogDisabled:
                "UNAVAILABLE: Codex session catalog is disabled"
            case .invalidAppServerConfiguration:
                "UNAVAILABLE: Codex app-server configuration is invalid"
            case .codexUnavailable:
                "UNAVAILABLE: Codex CLI not found"
            case .unsupportedAppServerTransport:
                "UNAVAILABLE: paired macOS Codex catalog supports appServer.transport stdio only"
            case .unsupportedAppServerHomeScope:
                "UNAVAILABLE: paired macOS Codex catalog requires appServer.homeScope user"
            case .appServerUnavailable:
                "UNAVAILABLE: Codex app-server thread list failed"
            case .responseTooLarge:
                "UNAVAILABLE: Codex app-server thread metadata exceeded the size limit"
            case .timedOut:
                "UNAVAILABLE: Codex app-server thread list timed out"
            }
        }

        var isInvalidRequest: Bool {
            if case .invalidParams = self {
                return true
            }
            return false
        }
    }

    private struct ListParams {
        var cursor: String?
        var limit = 50
        var searchTerm: String?
        var cwd: String?
    }

    private struct ConfiguredAppServer {
        var transport: String?
        var homeScope: String?
        var command: String?
        var args: [String]?
        var clearEnv: [String]
    }

    private struct ConfiguredPlugin {
        var supervisionEnabled: Bool
        var appServer: ConfiguredAppServer?
    }

    private enum StringOverflow {
        case omit
        case truncate
    }

    private static let defaultArguments = ["app-server", "--listen", "stdio://"]
    private static let commandEnvironmentKey = "OPENCLAW_CODEX_APP_SERVER_BIN"
    private static let argumentsEnvironmentKey = "OPENCLAW_CODEX_APP_SERVER_ARGS"
    private static let pluginConfigKeys = Set([
        "codexDynamicToolsLoading",
        "codexDynamicToolsExclude",
        "discovery",
        "computerUse",
        "codexPlugins",
        "supervision",
        "appServer",
    ])
    private static let appServerConfigKeys = Set([
        "mode",
        "transport",
        "homeScope",
        "command",
        "args",
        "url",
        "authToken",
        "headers",
        "clearEnv",
        "remoteWorkspaceRoot",
        "codeModeOnly",
        "requestTimeoutMs",
        "turnCompletionIdleTimeoutMs",
        "postToolRawAssistantCompletionIdleTimeoutMs",
        "approvalPolicy",
        "sandbox",
        "approvalsReviewer",
        "serviceTier",
        "networkProxy",
        "defaultWorkspaceDir",
        "experimental",
    ])
    static let defaultMacOSChatGPTAppExecutable =
        "/Applications/ChatGPT.app/Contents/Resources/codex"
    static let defaultUserMacOSChatGPTAppExecutable = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/ChatGPT.app/Contents/Resources/codex")
        .path
    static let defaultMacOSAppExecutable = "/Applications/Codex.app/Contents/Resources/codex"
    static let defaultUserMacOSAppExecutable = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/Codex.app/Contents/Resources/codex")
        .path
    static let defaultMacOSBetaAppExecutable = "/Applications/Codex Beta.app/Contents/Resources/codex"
    static let defaultUserMacOSBetaAppExecutable = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/Codex Beta.app/Contents/Resources/codex")
        .path
    static let defaultTimeoutSeconds: Double = 24
    private static let maxSessionIdLength = 256
    private static let maxSessionNameLength = 500
    private static let maxCwdLength = 4096
    private static let maxStatusLength = 64
    private static let maxMetadataLength = 500
    private static let maxActiveFlags = 16
    private static let maxActiveFlagLength = 128
    private static let maxCursorLength = 4096
    private static let maxSearchPageCalls = 4

    private struct WireResponse: Encodable {
        var sessions: [WireSession]
        var nextCursor: String?
        var backwardsCursor: String?
    }

    private struct WireSession: Encodable {
        var threadId: String
        var sessionId: String?
        var name: String?
        var cwd: String?
        var status: String
        var activeFlags: [String]?
        var createdAt: Int64?
        var updatedAt: Int64?
        var recencyAt: Int64?
        var source: String?
        var modelProvider: String?
        var cliVersion: String?
        var gitBranch: String?
        var archived: Bool
    }

    static func list(paramsJSON: String?) async throws -> String {
        try await self.list(paramsJSON: paramsJSON) {
            OpenClawConfigFile.loadDict()
        }
    }

    static func list(
        paramsJSON: String?,
        loadRoot: () -> [String: Any]) async throws -> String
    {
        let params = try self.decodeParams(paramsJSON)
        // Keep authorization and spawn selection on one config snapshot. A second read could
        // otherwise approve one command and launch another after a concurrent config rewrite.
        let root = loadRoot()
        guard self.shouldAdvertise(root: root) else {
            throw CatalogError.catalogDisabled
        }
        let invocation = try self.resolveInvocation(root: root)
        return try await self.list(params: params, invocation: invocation)
    }

    static func shouldAdvertise(root: [String: Any]? = nil) -> Bool {
        let root = root ?? OpenClawConfigFile.loadDict()
        guard OpenClawConfigFile.configuredBundledPluginAllowed(
            MacNodeCodexThreadCatalogContract.pluginId,
            root: root)
        else { return false }
        let plugin: ConfiguredPlugin?
        do {
            plugin = try self.configuredPlugin(root: root)
        } catch {
            return false
        }
        guard plugin?.supervisionEnabled == true else { return false }
        return self.supportsConfiguredTransport(plugin?.appServer) &&
            self.supportsConfiguredHomeScope(plugin?.appServer)
    }

    static func list(
        paramsJSON: String?,
        executable: String,
        arguments: [String]? = nil,
        cwd: URL? = nil,
        clearEnv: [String] = [],
        timeoutSeconds: Double = MacNodeCodexThreadCatalog.defaultTimeoutSeconds,
        maxLineBytes: Int = 5 * 1024 * 1024) async throws -> String
    {
        let params = try self.decodeParams(paramsJSON)
        return try await self.list(
            params: params,
            invocation: ResolvedInvocation(
                executable: executable,
                arguments: arguments ?? self.defaultArguments,
                cwd: cwd,
                clearEnv: clearEnv),
            timeoutSeconds: timeoutSeconds,
            maxLineBytes: maxLineBytes)
    }

    private static func list(
        params: ListParams,
        invocation: ResolvedInvocation,
        timeoutSeconds: Double = MacNodeCodexThreadCatalog.defaultTimeoutSeconds,
        maxLineBytes: Int = 5 * 1024 * 1024) async throws -> String
    {
        guard params.searchTerm != nil else {
            let session = try CodexAppServerThreadListSession(
                invocation: invocation,
                listParams: self.appServerParams(params),
                timeoutSeconds: timeoutSeconds,
                maxLineBytes: maxLineBytes)
            let output = try await session.run()
            return try self.normalize(listResultData: output.listResultData)
        }

        // Native search also inspects transcript-derived previews. Scan a bounded
        // number of unsearched pages and filter normalized titles locally instead.
        let deadline = Date().addingTimeInterval(max(0.01, timeoutSeconds))
        var sessions: [WireSession] = []
        var cursor = params.cursor
        var seenCursors = Set(cursor.map { [$0] } ?? [])
        var backwardsCursor: String?
        var nextCursor: String?

        for pageIndex in 0..<self.maxSearchPageCalls {
            let remainingLimit = params.limit - sessions.count
            guard remainingLimit > 0 else { break }
            let remainingTimeout = deadline.timeIntervalSinceNow
            guard remainingTimeout > 0 else { throw CatalogError.timedOut }

            var pageParams = params
            pageParams.cursor = cursor
            pageParams.limit = remainingLimit
            let session = try CodexAppServerThreadListSession(
                invocation: invocation,
                listParams: self.appServerParams(pageParams),
                timeoutSeconds: remainingTimeout,
                maxLineBytes: maxLineBytes)
            let output = try await session.run()
            let page = try self.normalizedResponse(
                listResultData: output.listResultData,
                searchTerm: params.searchTerm)
            if pageIndex == 0 {
                backwardsCursor = page.backwardsCursor
            }
            sessions.append(contentsOf: page.sessions)

            guard let candidateCursor = page.nextCursor else {
                nextCursor = nil
                break
            }
            guard !seenCursors.contains(candidateCursor) else {
                // A repeated opaque cursor cannot make forward progress. Stop the
                // page chain instead of handing callers a permanent load-more loop.
                nextCursor = nil
                break
            }
            nextCursor = candidateCursor
            if sessions.count >= params.limit || pageIndex + 1 == self.maxSearchPageCalls {
                break
            }
            seenCursors.insert(candidateCursor)
            cursor = candidateCursor
        }

        return try self.encodeResponse(WireResponse(
            sessions: sessions,
            nextCursor: nextCursor,
            backwardsCursor: backwardsCursor))
    }
}

extension MacNodeCodexThreadCatalog {
    static func resolveInvocation(
        root: [String: Any]? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        searchPaths: [String]? = nil,
        currentDirectoryURL: URL = URL(
            fileURLWithPath: FileManager.default.currentDirectoryPath,
            isDirectory: true),
        defaultMacOSChatGPTAppExecutable: String = MacNodeCodexThreadCatalog
            .defaultMacOSChatGPTAppExecutable,
        defaultUserMacOSChatGPTAppExecutable: String = MacNodeCodexThreadCatalog
            .defaultUserMacOSChatGPTAppExecutable,
        defaultMacOSAppExecutable: String = MacNodeCodexThreadCatalog.defaultMacOSAppExecutable,
        defaultUserMacOSAppExecutable: String = MacNodeCodexThreadCatalog.defaultUserMacOSAppExecutable,
        defaultMacOSBetaAppExecutable: String = MacNodeCodexThreadCatalog.defaultMacOSBetaAppExecutable,
        defaultUserMacOSBetaAppExecutable: String = MacNodeCodexThreadCatalog.defaultUserMacOSBetaAppExecutable) throws
        -> ResolvedInvocation
    {
        let root = root ?? OpenClawConfigFile.loadDict()
        let appServer = try self.configuredPlugin(root: root)?.appServer
        guard self.supportsConfiguredTransport(appServer) else {
            throw CatalogError.unsupportedAppServerTransport
        }
        guard self.supportsConfiguredHomeScope(appServer) else {
            throw CatalogError.unsupportedAppServerHomeScope
        }
        let configuredCommand = self.nonEmptyString(appServer?.command)
        let environmentCommand = self.nonEmptyString(environment[self.commandEnvironmentKey])
        let customCommand = configuredCommand ?? environmentCommand
        let rawCommand = customCommand ?? "codex"
        let command = rawCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else { throw CatalogError.codexUnavailable }

        let executable: String?
        var installedAppExecutable: String?
        if customCommand == nil {
            installedAppExecutable = [
                defaultMacOSChatGPTAppExecutable,
                defaultUserMacOSChatGPTAppExecutable,
                defaultMacOSAppExecutable,
                defaultUserMacOSAppExecutable,
                defaultMacOSBetaAppExecutable,
                defaultUserMacOSBetaAppExecutable,
            ]
                .first { FileManager.default.isExecutableFile(atPath: $0) }
        }
        if let installedAppExecutable {
            executable = installedAppExecutable
        } else if command.contains("/") || command.hasPrefix("~") {
            let url = self.resolvePath(command, relativeTo: currentDirectoryURL)
            executable = FileManager.default.isExecutableFile(atPath: url.path) ? url.path : nil
        } else {
            executable = CommandResolver.findExecutable(named: command, searchPaths: searchPaths)
        }
        guard let executable else { throw CatalogError.codexUnavailable }
        let configuredArguments = appServer?.args ?? environment[self.argumentsEnvironmentKey].map {
            self.splitShellWords($0)
        }
        let arguments = if let configuredArguments, !configuredArguments.isEmpty {
            configuredArguments
        } else {
            self.defaultArguments
        }
        return ResolvedInvocation(
            executable: executable,
            arguments: arguments,
            cwd: nil,
            clearEnv: appServer?.clearEnv ?? [])
    }

    private static func supportsConfiguredTransport(_ appServer: ConfiguredAppServer?) -> Bool {
        appServer?.transport == nil || appServer?.transport == "stdio"
    }

    private static func supportsConfiguredHomeScope(_ appServer: ConfiguredAppServer?) -> Bool {
        appServer?.homeScope == nil || appServer?.homeScope == "user"
    }

    private static func configuredPlugin(root: [String: Any]) throws -> ConfiguredPlugin? {
        guard let entry = OpenClawConfigFile.pluginEntry(
            MacNodeCodexThreadCatalogContract.pluginId,
            root: root)
        else { return nil }
        guard let rawConfig = entry["config"] else {
            return ConfiguredPlugin(supervisionEnabled: false, appServer: nil)
        }
        guard let config = rawConfig as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        try self.validateKeys(config, allowed: self.pluginConfigKeys)
        try self.validateEnum(
            config,
            key: "codexDynamicToolsLoading",
            allowed: ["searchable", "direct"])
        try self.validateStringArray(config, key: "codexDynamicToolsExclude")
        try self.validateDiscoveryConfig(config["discovery"])
        try self.validateComputerUseConfig(config["computerUse"])
        // `codexPlugins` is intentionally parsed independently by readCodexPluginConfig.
        // Its validity does not decide whether supervision remains enabled.
        let supervisionEnabled = try self.validateSupervisionConfig(config["supervision"])
        let appServer = try self.validateAppServerConfig(config["appServer"])
        return ConfiguredPlugin(
            supervisionEnabled: supervisionEnabled,
            appServer: appServer)
    }

    private static func validateAppServerConfig(_ rawValue: Any?) throws -> ConfiguredAppServer? {
        guard let rawValue else { return nil }
        guard let appServer = rawValue as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        try self.validateKeys(appServer, allowed: self.appServerConfigKeys)
        try self.validateEnum(appServer, key: "mode", allowed: ["yolo", "guardian"])
        try self.validateEnum(appServer, key: "transport", allowed: ["stdio", "websocket", "unix"])
        try self.validateEnum(appServer, key: "homeScope", allowed: ["agent", "user"])
        try self.validateString(appServer, key: "command")
        try self.validateString(appServer, key: "url")
        try self.validateSecretInput(appServer["authToken"])
        try self.validateHeaders(appServer["headers"])
        try self.validateStringArray(appServer, key: "clearEnv")
        try self.validateNonEmptyString(appServer, key: "remoteWorkspaceRoot")
        try self.validateBoolean(appServer, key: "codeModeOnly")
        try self.validatePositiveNumber(appServer, key: "requestTimeoutMs")
        try self.validatePositiveNumber(appServer, key: "turnCompletionIdleTimeoutMs")
        try self.validatePositiveNumber(
            appServer,
            key: "postToolRawAssistantCompletionIdleTimeoutMs")
        try self.validateEnum(
            appServer,
            key: "approvalPolicy",
            allowed: ["never", "on-request", "on-failure", "untrusted"])
        try self.validateEnum(
            appServer,
            key: "sandbox",
            allowed: ["read-only", "workspace-write", "danger-full-access"])
        try self.validateEnum(
            appServer,
            key: "approvalsReviewer",
            allowed: ["user", "auto_review", "guardian_subagent"])
        try self.validateStringOrNull(appServer, key: "serviceTier")
        try self.validateNetworkProxyConfig(appServer["networkProxy"])
        try self.validateString(appServer, key: "defaultWorkspaceDir")
        try self.validateExperimentalConfig(appServer["experimental"])

        let transport = try self.optionalConfiguredString(appServer, key: "transport")
        let homeScope = try self.optionalConfiguredString(appServer, key: "homeScope")
        let command = try self.optionalConfiguredString(appServer, key: "command")
        let args = try self.configuredArguments(appServer, key: "args")
        let clearEnv = try self.configuredStringList(appServer, key: "clearEnv")

        return ConfiguredAppServer(
            transport: transport,
            homeScope: homeScope,
            command: self.nonEmptyString(command),
            args: args,
            clearEnv: clearEnv)
    }

    private static func optionalConfiguredString(
        _ object: [String: Any],
        key: String) throws -> String?
    {
        guard let value = object[key] else { return nil }
        guard let value = value as? String else {
            throw CatalogError.invalidAppServerConfiguration
        }
        return value
    }

    private static func configuredArguments(
        _ object: [String: Any],
        key: String) throws -> [String]?
    {
        guard let value = object[key] else { return nil }
        let args: [String]
        if let values = value as? [Any] {
            guard values.allSatisfy({ $0 is String }) else {
                throw CatalogError.invalidAppServerConfiguration
            }
            args = values.compactMap(self.nonEmptyString)
        } else if let value = value as? String {
            args = self.splitShellWords(value)
        } else {
            throw CatalogError.invalidAppServerConfiguration
        }
        return args
    }

    private static func configuredStringList(
        _ object: [String: Any],
        key: String) throws -> [String]
    {
        guard let value = object[key] else { return [] }
        guard let values = value as? [Any], values.allSatisfy({ $0 is String }) else {
            throw CatalogError.invalidAppServerConfiguration
        }
        return values.compactMap(self.nonEmptyString)
    }

    private static func validateDiscoveryConfig(_ rawValue: Any?) throws {
        guard let rawValue else { return }
        guard let config = rawValue as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        try self.validateKeys(config, allowed: ["enabled", "timeoutMs"])
        try self.validateBoolean(config, key: "enabled")
        try self.validatePositiveNumber(config, key: "timeoutMs")
    }

    private static func validateComputerUseConfig(_ rawValue: Any?) throws {
        guard let rawValue else { return }
        guard let config = rawValue as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        try self.validateKeys(config, allowed: [
            "enabled",
            "autoInstall",
            "marketplaceDiscoveryTimeoutMs",
            "marketplaceSource",
            "marketplacePath",
            "marketplaceName",
            "pluginName",
            "mcpServerName",
        ])
        try self.validateBoolean(config, key: "enabled")
        try self.validateBoolean(config, key: "autoInstall")
        try self.validatePositiveNumber(config, key: "marketplaceDiscoveryTimeoutMs")
        for key in [
            "marketplaceSource",
            "marketplacePath",
            "marketplaceName",
            "pluginName",
            "mcpServerName",
        ] {
            try self.validateString(config, key: key)
        }
    }

    private static func validateSupervisionConfig(_ rawValue: Any?) throws -> Bool {
        guard let rawValue else { return false }
        guard let config = rawValue as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        try self.validateKeys(config, allowed: [
            "enabled",
            "endpoints",
            "allowRawTranscripts",
            "allowWriteControls",
        ])
        try self.validateBoolean(config, key: "enabled")
        try self.validateBoolean(config, key: "allowRawTranscripts")
        try self.validateBoolean(config, key: "allowWriteControls")
        if let rawEndpoints = config["endpoints"] {
            guard let endpoints = rawEndpoints as? [Any] else {
                throw CatalogError.invalidAppServerConfiguration
            }
            for endpoint in endpoints {
                try self.validateSupervisionEndpoint(endpoint)
            }
        }
        return self.literalBoolean(config["enabled"]) == true
    }

    private static func validateSupervisionEndpoint(_ rawValue: Any) throws {
        guard let endpoint = rawValue as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        let transport = endpoint["transport"] as? String
        if transport == nil || transport == "stdio-proxy" {
            try self.validateKeys(
                endpoint,
                allowed: ["id", "label", "transport", "command", "args", "cwd"])
            for key in ["id", "label", "command", "cwd"] {
                try self.validateString(endpoint, key: key)
            }
            try self.validateEnum(endpoint, key: "transport", allowed: ["stdio-proxy"])
            try self.validateStringArray(endpoint, key: "args")
            return
        }
        guard transport == "websocket" else {
            throw CatalogError.invalidAppServerConfiguration
        }
        try self.validateKeys(
            endpoint,
            allowed: ["id", "label", "transport", "url", "authTokenEnv"])
        for key in ["id", "label", "authTokenEnv"] {
            try self.validateString(endpoint, key: key)
        }
        guard endpoint["url"] is String else {
            throw CatalogError.invalidAppServerConfiguration
        }
    }

    private static func validateNetworkProxyConfig(_ rawValue: Any?) throws {
        guard let rawValue else { return }
        guard let config = rawValue as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        try self.validateKeys(config, allowed: [
            "enabled",
            "profileName",
            "baseProfile",
            "mode",
            "domains",
            "unixSockets",
            "proxyUrl",
            "socksUrl",
            "enableSocks5",
            "enableSocks5Udp",
            "allowUpstreamProxy",
            "allowLocalBinding",
            "dangerouslyAllowNonLoopbackProxy",
            "dangerouslyAllowAllUnixSockets",
        ])
        for key in [
            "enabled",
            "enableSocks5",
            "enableSocks5Udp",
            "allowUpstreamProxy",
            "allowLocalBinding",
            "dangerouslyAllowNonLoopbackProxy",
            "dangerouslyAllowAllUnixSockets",
        ] {
            try self.validateBoolean(config, key: key)
        }
        for key in ["profileName", "proxyUrl", "socksUrl"] {
            try self.validateNonEmptyString(config, key: key)
        }
        try self.validateEnum(config, key: "baseProfile", allowed: ["read-only", "workspace"])
        try self.validateEnum(config, key: "mode", allowed: ["limited", "full"])
        try self.validateStringRecord(
            config,
            key: "domains",
            allowedValues: ["allow", "deny"])
        try self.validateStringRecord(
            config,
            key: "unixSockets",
            allowedValues: ["allow", "none"])
    }

    private static func validateExperimentalConfig(_ rawValue: Any?) throws {
        guard let rawValue else { return }
        guard let config = rawValue as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        try self.validateKeys(config, allowed: ["sandboxExecServer"])
        try self.validateBoolean(config, key: "sandboxExecServer")
    }

    private static func validateHeaders(_ rawValue: Any?) throws {
        guard let rawValue else { return }
        guard let headers = rawValue as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        for value in headers.values {
            try self.validateSecretInput(value)
        }
    }

    private static func validateSecretInput(_ rawValue: Any?) throws {
        guard let rawValue else { return }
        if rawValue is String {
            return
        }
        guard let secret = rawValue as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        try self.validateKeys(secret, allowed: ["source", "provider", "id"])
        guard secret.keys.count == 3,
              let source = secret["source"] as? String,
              let provider = secret["provider"] as? String,
              let id = secret["id"] as? String,
              self.matches(provider, pattern: "^[a-z][a-z0-9_-]{0,63}$")
        else {
            throw CatalogError.invalidAppServerConfiguration
        }
        let validId = switch source {
        case "env":
            self.matches(id, pattern: "^[A-Z][A-Z0-9_]{0,127}$")
        case "file":
            self.validFileSecretId(id)
        case "exec":
            self.matches(id, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$") &&
                !id.split(separator: "/", omittingEmptySubsequences: false)
                .contains(where: { $0 == "." || $0 == ".." })
        default:
            false
        }
        guard validId else { throw CatalogError.invalidAppServerConfiguration }
    }

    private static func validFileSecretId(_ value: String) -> Bool {
        if value == "value" {
            return true
        }
        guard value.hasPrefix("/") else { return false }
        return value.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
            .allSatisfy { segment in
                segment.range(of: "~(?:[^01]|$)", options: .regularExpression) == nil
            }
    }

    private static func validateKeys(
        _ object: [String: Any],
        allowed: Set<String>) throws
    {
        guard object.keys.allSatisfy(allowed.contains) else {
            throw CatalogError.invalidAppServerConfiguration
        }
    }

    private static func validateBoolean(_ object: [String: Any], key: String) throws {
        guard let value = object[key] else { return }
        guard self.literalBoolean(value) != nil else {
            throw CatalogError.invalidAppServerConfiguration
        }
    }

    private static func validateString(_ object: [String: Any], key: String) throws {
        guard let value = object[key] else { return }
        guard value is String else { throw CatalogError.invalidAppServerConfiguration }
    }

    private static func validateNonEmptyString(_ object: [String: Any], key: String) throws {
        guard let value = object[key] else { return }
        guard let value = value as? String,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw CatalogError.invalidAppServerConfiguration
        }
    }

    private static func validateStringOrNull(_ object: [String: Any], key: String) throws {
        guard let value = object[key] else { return }
        guard value is String || value is NSNull else {
            throw CatalogError.invalidAppServerConfiguration
        }
    }

    private static func validateEnum(
        _ object: [String: Any],
        key: String,
        allowed: Set<String>) throws
    {
        guard let value = object[key] else { return }
        guard let value = value as? String, allowed.contains(value) else {
            throw CatalogError.invalidAppServerConfiguration
        }
    }

    private static func validatePositiveNumber(_ object: [String: Any], key: String) throws {
        guard let value = object[key] else { return }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,
              number.doubleValue > 0
        else {
            throw CatalogError.invalidAppServerConfiguration
        }
    }

    private static func validateStringArray(_ object: [String: Any], key: String) throws {
        guard let value = object[key] else { return }
        guard let values = value as? [Any], values.allSatisfy({ $0 is String }) else {
            throw CatalogError.invalidAppServerConfiguration
        }
    }

    private static func validateStringRecord(
        _ object: [String: Any],
        key: String,
        allowedValues: Set<String>) throws
    {
        guard let value = object[key] else { return }
        guard let values = value as? [String: Any],
              values.values.allSatisfy({ value in
                  guard let value = value as? String else { return false }
                  return allowedValues.contains(value)
              })
        else {
            throw CatalogError.invalidAppServerConfiguration
        }
    }

    private static func literalBoolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID()
        else { return nil }
        return number.boolValue
    }

    private static func matches(_ value: String, pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    /// Match the TypeScript app-server config parser exactly: quotes only group
    /// words and backslashes are ordinary characters. The result never uses a shell.
    private static func splitShellWords(_ value: String) -> [String] {
        var words: [String] = []
        var current = ""
        var activeQuote: Character?
        for character in value {
            if let expectedQuote = activeQuote {
                if character == expectedQuote {
                    activeQuote = nil
                } else {
                    current.append(character)
                }
                continue
            }
            if character == "\"" || character == "'" {
                activeQuote = character
            } else if character.isWhitespace {
                if !current.isEmpty {
                    words.append(current)
                    current = ""
                }
            } else {
                current.append(character)
            }
        }
        if !current.isEmpty {
            words.append(current)
        }
        return words
    }

    private static func resolvePath(
        _ path: String,
        relativeTo base: URL,
        isDirectory: Bool = false) -> URL
    {
        let expanded = (path as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return URL(fileURLWithPath: expanded, isDirectory: isDirectory).standardizedFileURL
        }
        return URL(fileURLWithPath: expanded, isDirectory: isDirectory, relativeTo: base)
            .standardizedFileURL
    }

    private static func decodeParams(_ paramsJSON: String?) throws -> ListParams {
        guard let paramsJSON, !paramsJSON.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return ListParams()
        }
        guard let data = paramsJSON.data(using: .utf8) else {
            throw CatalogError.invalidParams("parameters must be valid JSON")
        }
        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw CatalogError.invalidParams("parameters must be valid JSON")
        }
        guard let raw = raw as? [String: Any] else {
            throw CatalogError.invalidParams("parameters must be an object")
        }
        let allowed = Set(["cursor", "limit", "searchTerm", "cwd"])
        if let unknown = raw.keys.first(where: { !allowed.contains($0) }) {
            throw CatalogError.invalidParams("unknown Codex session catalog parameter: \(unknown)")
        }

        var params = ListParams()
        params.cursor = try self.optionalString(raw, key: "cursor", maxLength: self.maxCursorLength)
        params.searchTerm = try self.optionalString(
            raw,
            key: "searchTerm",
            maxLength: self.maxSessionNameLength)
        params.cwd = try self.optionalString(raw, key: "cwd", maxLength: self.maxCwdLength)
        if let value = raw["limit"] {
            guard let number = value as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.rounded() == number.doubleValue,
                  (1...100).contains(number.intValue)
            else {
                throw CatalogError.invalidParams("limit must be an integer from 1 to 100")
            }
            params.limit = number.intValue
        }
        return params
    }

    private static func optionalString(
        _ params: [String: Any],
        key: String,
        maxLength: Int) throws -> String?
    {
        guard let value = params[key] else { return nil }
        guard let value = value as? String else {
            throw CatalogError.invalidParams("\(key) must be a string")
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.utf16.count <= maxLength else {
            throw CatalogError.invalidParams("\(key) must be at most \(maxLength) characters")
        }
        return trimmed
    }

    private static func appServerParams(_ params: ListParams) -> [String: Any] {
        var result: [String: Any] = [
            "limit": params.limit,
            "sortKey": "recency_at",
            "sortDirection": "desc",
            // An empty provider list means all providers. Omitting sourceKinds keeps
            // Codex's stable interactive-session default.
            "modelProviders": [String](),
            "archived": false,
            "useStateDbOnly": false,
        ]
        if let cursor = params.cursor {
            result["cursor"] = cursor
        }
        // Search only the normalized names below. App Server title search can
        // match transcript-derived previews that the node boundary withholds.
        if let cwd = params.cwd {
            result["cwd"] = cwd
        }
        return result
    }

    static func normalize(
        listResultData: Data,
        searchTerm: String? = nil) throws -> String
    {
        try self.encodeResponse(self.normalizedResponse(
            listResultData: listResultData,
            searchTerm: searchTerm))
    }

    private static func normalizedResponse(
        listResultData: Data,
        searchTerm: String? = nil) throws -> WireResponse
    {
        guard let result = try JSONSerialization.jsonObject(with: listResultData) as? [String: Any],
              let rawThreads = result["data"] as? [Any]
        else {
            throw CatalogError.appServerUnavailable
        }

        let sessions = rawThreads.compactMap { value -> WireSession? in
            guard let thread = value as? [String: Any],
                  let threadId = self.boundedString(
                      thread["id"],
                      maxLength: self.maxSessionIdLength)
            else { return nil }
            let statusRecord = thread["status"] as? [String: Any]
            let status = self.boundedString(
                statusRecord?["type"],
                maxLength: self.maxStatusLength) ?? "notLoaded"
            let decodedActiveFlags = (statusRecord?["activeFlags"] as? [Any])?
                .compactMap {
                    self.boundedString($0, maxLength: self.maxActiveFlagLength)
                }
                .prefix(self.maxActiveFlags)
            let activeFlags = decodedActiveFlags?.isEmpty == false ? decodedActiveFlags : nil
            let gitInfo = thread["gitInfo"] as? [String: Any]
            let name = self.boundedString(
                thread["name"],
                maxLength: self.maxSessionNameLength,
                overflow: .truncate)
            if let searchTerm,
               name?.range(of: searchTerm, options: [.caseInsensitive, .literal]) == nil
            {
                return nil
            }
            return WireSession(
                threadId: threadId,
                sessionId: self.boundedString(
                    thread["sessionId"],
                    maxLength: self.maxSessionIdLength),
                name: name,
                cwd: self.boundedString(thread["cwd"], maxLength: self.maxCwdLength),
                status: status,
                activeFlags: activeFlags.map(Array.init),
                createdAt: self.integer(thread["createdAt"]),
                updatedAt: self.integer(thread["updatedAt"]),
                recencyAt: self.integer(thread["recencyAt"]),
                source: self.sourceName(thread["source"]),
                modelProvider: self.boundedString(
                    thread["modelProvider"],
                    maxLength: self.maxMetadataLength,
                    overflow: .truncate),
                cliVersion: self.boundedString(
                    thread["cliVersion"],
                    maxLength: self.maxMetadataLength,
                    overflow: .truncate),
                gitBranch: self.boundedString(
                    gitInfo?["branch"],
                    maxLength: self.maxMetadataLength,
                    overflow: .truncate),
                archived: false)
        }

        return WireResponse(
            sessions: sessions,
            nextCursor: self.boundedCursor(result["nextCursor"]),
            backwardsCursor: self.boundedCursor(result["backwardsCursor"]))
    }

    private static func encodeResponse(_ response: WireResponse) throws -> String {
        let data = try JSONEncoder().encode(response)
        guard let json = String(data: data, encoding: .utf8) else {
            throw CatalogError.appServerUnavailable
        }
        return json
    }

    fileprivate static func nonEmptyString(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func boundedString(
        _ value: Any?,
        maxLength: Int,
        overflow: StringOverflow = .omit) -> String?
    {
        guard let value = self.nonEmptyString(value) else { return nil }
        guard value.utf16.count > maxLength else { return value }
        guard case .truncate = overflow else { return nil }
        return self.truncateUTF16(value, maxLength: maxLength)
    }

    private static func boundedCursor(_ value: Any?) -> String? {
        guard let value = value as? String,
              self.nonEmptyString(value) != nil,
              value.utf16.count <= self.maxCursorLength
        else { return nil }
        // App Server cursors are opaque; do not trim or regenerate them after
        // locally filtering a page by its normalized session names.
        return value
    }

    private static func truncateUTF16(_ value: String, maxLength: Int) -> String {
        var result = ""
        var length = 0
        for scalar in value.unicodeScalars {
            let scalarLength = scalar.value > 0xFFFF ? 2 : 1
            guard length + scalarLength <= maxLength else { break }
            result.unicodeScalars.append(scalar)
            length += scalarLength
        }
        return result
    }

    private static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else { return nil }
        return number.int64Value
    }

    private static func sourceName(_ value: Any?) -> String? {
        let raw: String? = if let source = self.nonEmptyString(value) {
            source
        } else if let source = value as? [String: Any],
                  let custom = self.nonEmptyString(source["custom"])
        {
            "custom:\(custom)"
        } else if let source = value as? [String: Any] {
            source.keys.min()
        } else {
            nil
        }
        return self.boundedString(
            raw,
            maxLength: self.maxMetadataLength,
            overflow: .truncate)
    }
}

private final class CodexAppServerThreadListSession: @unchecked Sendable {
    struct Output {
        var listResultData: Data
    }

    private enum Phase {
        case initialize
        case list
    }

    private let process = Process()
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let stderrPipe = Pipe()
    private let queue = DispatchQueue(label: "ai.openclaw.codex-thread-catalog")
    private let listRequestData: Data
    private let timeoutSeconds: Double
    private let maxLineBytes: Int
    private var continuation: CheckedContinuation<Output, Error>?
    private var timer: DispatchSourceTimer?
    private var stdoutBuffer = Data()
    private var phase = Phase.initialize
    private var finished = false
    private var launched = false

    private struct ReadChunk {
        var data: Data
        var reachedEOF: Bool
    }

    init(
        invocation: MacNodeCodexThreadCatalog.ResolvedInvocation,
        listParams: [String: Any],
        timeoutSeconds: Double,
        maxLineBytes: Int) throws
    {
        self.process.executableURL = URL(fileURLWithPath: invocation.executable)
        self.process.arguments = invocation.arguments
        self.process.currentDirectoryURL = invocation.cwd
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        for key in invocation.clearEnv {
            environment.removeValue(forKey: key)
        }
        self.process.environment = environment
        self.process.standardInput = self.stdinPipe
        self.process.standardOutput = self.stdoutPipe
        self.process.standardError = self.stderrPipe
        self.timeoutSeconds = max(0.01, timeoutSeconds)
        self.maxLineBytes = max(1, maxLineBytes)
        self.listRequestData = try Self.jsonData([
            "id": 2,
            "method": "thread/list",
            "params": listParams,
        ])
    }

    func run() async throws -> Output {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.queue.async {
                    self.start(continuation)
                }
            }
        } onCancel: {
            self.queue.async {
                self.finish(.failure(CancellationError()))
            }
        }
    }

    private func start(_ continuation: CheckedContinuation<Output, Error>) {
        guard !self.finished else {
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        // DispatchSource readability callbacks may be followed by future drain
        // loops. Keep both pipes non-blocking so an open App Server cannot stall
        // the catalog handshake after emitting one JSON-RPC frame.
        Self.setNonBlocking(self.stdoutPipe.fileHandleForReading)
        Self.setNonBlocking(self.stderrPipe.fileHandleForReading)
        self.stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let session = self else { return }
            session.queue.async { [session] in
                session.drainStdout(from: handle)
            }
        }
        // Drain stderr so the child cannot block. App Server stderr is deliberately
        // not forwarded over the Gateway because it may contain local paths.
        self.stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            if Self.drainAvailable(from: handle) {
                handle.readabilityHandler = nil
            }
        }
        self.process.terminationHandler = { [weak self] _ in
            guard let session = self else { return }
            session.queue.async { [session] in
                // A short-lived App Server can exit before its readability callback
                // is admitted. Drain its final frame before projecting termination.
                session.drainStdout(from: session.stdoutPipe.fileHandleForReading)
                guard !session.finished else { return }
                session.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
            }
        }

        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        timer.schedule(deadline: .now() + self.timeoutSeconds)
        timer.setEventHandler { [weak self] in
            self?.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.timedOut))
        }
        self.timer = timer
        timer.resume()

        do {
            try self.process.run()
            self.launched = true
            try self.write(Self.initializeRequestData())
        } catch {
            self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
        }
    }

    private func drainStdout(from handle: FileHandle) {
        guard !self.finished else { return }
        let chunk = Self.readAvailable(from: handle, maxBytes: self.maxLineBytes)
        if chunk.reachedEOF {
            handle.readabilityHandler = nil
        }
        guard !chunk.data.isEmpty else { return }
        self.consumeStdout(chunk.data)
    }

    private func consumeStdout(_ data: Data) {
        guard !self.finished else { return }
        self.stdoutBuffer.append(data)
        guard self.stdoutBuffer.count <= self.maxLineBytes else {
            self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.responseTooLarge))
            return
        }

        while let newline = self.stdoutBuffer.firstIndex(of: 0x0A) {
            let line = self.stdoutBuffer.prefix(upTo: newline)
            self.stdoutBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            self.handleLine(Data(line))
            if self.finished {
                return
            }
        }
    }

    private func handleLine(_ data: Data) {
        guard let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = (message["id"] as? NSNumber)?.intValue
        else { return }

        if message["error"] is [String: Any] {
            self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
            return
        }

        switch (self.phase, id) {
        case (.initialize, 1):
            guard message["result"] is [String: Any] else {
                self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
                return
            }
            self.phase = .list
            do {
                try self.write(Self.initializedNotificationData())
                try self.write(self.listRequestData)
            } catch {
                self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
            }
        case (.list, 2):
            guard let result = message["result"] as? [String: Any],
                  let resultData = try? Self.jsonData(result)
            else {
                self.finish(.failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable))
                return
            }
            self.finish(.success(Output(listResultData: resultData)))
        default:
            break
        }
    }

    private func write(_ data: Data) throws {
        var frame = data
        frame.append(0x0A)
        try self.stdinPipe.fileHandleForWriting.write(contentsOf: frame)
    }

    private func finish(_ result: Result<Output, Error>) {
        guard !self.finished else { return }
        self.finished = true
        self.timer?.cancel()
        self.timer = nil
        self.stdoutPipe.fileHandleForReading.readabilityHandler = nil
        self.stderrPipe.fileHandleForReading.readabilityHandler = nil
        try? self.stdinPipe.fileHandleForWriting.close()
        if self.launched, self.process.isRunning {
            self.process.terminate()
        }
        guard let continuation = self.continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }

    private static func initializeRequestData() throws -> Data {
        try self.jsonData([
            "id": 1,
            "method": "initialize",
            "params": [
                "clientInfo": [
                    "name": "openclaw_macos",
                    "title": "OpenClaw macOS Node",
                    "version": GatewayEnvironment.appVersionString() ?? "unknown",
                ],
            ],
        ])
    }

    private static func initializedNotificationData() throws -> Data {
        try self.jsonData(["method": "initialized"])
    }

    private static func jsonData(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    private static func readAvailable(from handle: FileHandle, maxBytes: Int) -> ReadChunk {
        // FileHandle.read(upToCount:) can wait for EOF despite a readability callback.
        // The descriptor is non-blocking, so drain one complete JSONL frame (or
        // the response cap plus one byte) without waiting for the App Server to exit.
        var data = Data()
        let captureLimit = maxBytes == Int.max ? Int.max : maxBytes + 1
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(handle.fileDescriptor, bytes.baseAddress, bytes.count)
            }
            if count > 0 {
                let remaining = max(0, captureLimit - data.count)
                data.append(contentsOf: buffer.prefix(min(count, remaining)))
                if data.count > maxBytes {
                    return ReadChunk(data: data, reachedEOF: false)
                }
                continue
            }
            if count == 0 {
                return ReadChunk(data: data, reachedEOF: true)
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                return ReadChunk(data: data, reachedEOF: false)
            }
            return ReadChunk(data: data, reachedEOF: true)
        }
    }

    private static func drainAvailable(from handle: FileHandle) -> Bool {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(handle.fileDescriptor, bytes.baseAddress, bytes.count)
            }
            if count > 0 {
                continue
            }
            if count == 0 {
                return true
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                return false
            }
            return true
        }
    }

    private static func setNonBlocking(_ handle: FileHandle) {
        let descriptor = handle.fileDescriptor
        let flags = Darwin.fcntl(descriptor, F_GETFL)
        if flags >= 0 {
            _ = Darwin.fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
        }
    }
}

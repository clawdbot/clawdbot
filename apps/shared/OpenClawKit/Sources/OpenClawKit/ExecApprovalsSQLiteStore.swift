import Foundation
import OpenClawNativeState

public enum ExecApprovalsSecurity: String, CaseIterable, Codable, Identifiable, Sendable {
    case deny
    case allowlist
    case full

    public var id: String {
        self.rawValue
    }
}

public enum ExecApprovalsAsk: String, CaseIterable, Codable, Identifiable, Sendable {
    case off
    case onMiss = "on-miss"
    case always

    public var id: String {
        self.rawValue
    }
}

public struct ExecApprovalsAllowlistEntry: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var pattern: String
    public var source: String?
    public var commandText: String?
    public var argPattern: String?
    public var lastUsedAt: Double?
    public var lastUsedCommand: String?
    public var lastResolvedPath: String?

    public init(
        id: String = UUID().uuidString,
        pattern: String,
        source: String? = nil,
        commandText: String? = nil,
        argPattern: String? = nil,
        lastUsedAt: Double? = nil,
        lastUsedCommand: String? = nil,
        lastResolvedPath: String? = nil)
    {
        self.id = id
        self.pattern = pattern
        self.source = source
        self.commandText = commandText
        self.argPattern = argPattern
        self.lastUsedAt = lastUsedAt
        self.lastUsedCommand = lastUsedCommand
        self.lastResolvedPath = lastResolvedPath
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case pattern
        case source
        case commandText
        case argPattern
        case lastUsedAt
        case lastUsedCommand
        case lastResolvedPath
    }

    public init(from decoder: Decoder) throws {
        if let container = try? decoder.singleValueContainer(),
           let legacyPattern = try? container.decode(String.self)
        {
            self.init(pattern: legacyPattern.trimmingCharacters(in: .whitespacesAndNewlines))
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedID = try container.decodeIfPresent(String.self, forKey: .id)
        let id = decodedID.flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
        try self.init(
            id: id,
            pattern: container.decode(String.self, forKey: .pattern),
            source: container.decodeIfPresent(String.self, forKey: .source),
            commandText: container.decodeIfPresent(String.self, forKey: .commandText),
            argPattern: container.decodeIfPresent(String.self, forKey: .argPattern),
            lastUsedAt: container.decodeIfPresent(Double.self, forKey: .lastUsedAt),
            lastUsedCommand: container.decodeIfPresent(String.self, forKey: .lastUsedCommand),
            lastResolvedPath: container.decodeIfPresent(String.self, forKey: .lastResolvedPath))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.id, forKey: .id)
        try container.encode(self.pattern, forKey: .pattern)
        try container.encodeIfPresent(self.source, forKey: .source)
        try container.encodeIfPresent(self.argPattern, forKey: .argPattern)
        try container.encodeIfPresent(self.lastUsedAt, forKey: .lastUsedAt)
        try container.encodeIfPresent(self.lastUsedCommand, forKey: .lastUsedCommand)
        try container.encodeIfPresent(self.lastResolvedPath, forKey: .lastResolvedPath)
    }
}

public struct ExecApprovalsDefaultsDocument: Codable, Sendable, Equatable {
    public var security: ExecApprovalsSecurity?
    public var ask: ExecApprovalsAsk?
    public var askFallback: ExecApprovalsSecurity?
    public var autoAllowSkills: Bool?

    public init(
        security: ExecApprovalsSecurity? = nil,
        ask: ExecApprovalsAsk? = nil,
        askFallback: ExecApprovalsSecurity? = nil,
        autoAllowSkills: Bool? = nil)
    {
        self.security = security
        self.ask = ask
        self.askFallback = askFallback
        self.autoAllowSkills = autoAllowSkills
    }
}

public struct ExecApprovalsAgentDocument: Codable, Sendable, Equatable {
    public var security: ExecApprovalsSecurity?
    public var ask: ExecApprovalsAsk?
    public var askFallback: ExecApprovalsSecurity?
    public var autoAllowSkills: Bool?
    public var allowlist: [ExecApprovalsAllowlistEntry]?

    public init(
        security: ExecApprovalsSecurity? = nil,
        ask: ExecApprovalsAsk? = nil,
        askFallback: ExecApprovalsSecurity? = nil,
        autoAllowSkills: Bool? = nil,
        allowlist: [ExecApprovalsAllowlistEntry]? = nil)
    {
        self.security = security
        self.ask = ask
        self.askFallback = askFallback
        self.autoAllowSkills = autoAllowSkills
        self.allowlist = allowlist
    }

    public var isEmpty: Bool {
        self.security == nil && self.ask == nil && self.askFallback == nil
            && self.autoAllowSkills == nil && (self.allowlist?.isEmpty ?? true)
    }
}

public struct ExecApprovalsSocketDocument: Codable, Sendable, Equatable {
    public var path: String?
    public var token: String?

    public init(path: String? = nil, token: String? = nil) {
        self.path = path
        self.token = token
    }
}

public struct ExecApprovalsDocument: Codable, Sendable, Equatable {
    public var version: Int
    public var socket: ExecApprovalsSocketDocument?
    public var defaults: ExecApprovalsDefaultsDocument?
    public var agents: [String: ExecApprovalsAgentDocument]?

    public init(
        version: Int,
        socket: ExecApprovalsSocketDocument? = nil,
        defaults: ExecApprovalsDefaultsDocument? = nil,
        agents: [String: ExecApprovalsAgentDocument]? = nil)
    {
        self.version = version
        self.socket = socket
        self.defaults = defaults
        self.agents = agents
    }
}

public struct ExecApprovalsSQLiteRecord: Sendable, Equatable {
    public let rawJSON: String
    public let document: ExecApprovalsDocument

    public init(rawJSON: String, document: ExecApprovalsDocument) {
        self.rawJSON = rawJSON
        self.document = document
    }
}

public struct ExecApprovalsSQLiteMutation<Value> {
    public let value: Value
    public let documentToWrite: ExecApprovalsDocument?

    public init(value: Value, documentToWrite: ExecApprovalsDocument? = nil) {
        self.value = value
        self.documentToWrite = documentToWrite
    }
}

public enum ExecApprovalsSQLiteStore {
    public static let configKey = "current"
    public static let locator = "state/openclaw.sqlite#exec_approvals_config"
    static let mutationLeaseScope = "exec-approvals"
    static let mutationLeaseKey = "mutation"
    private static let busyTimeoutMilliseconds: Int32 = 30000

    public static func databaseURL(stateDirectoryURL: URL) -> URL {
        stateDirectoryURL
            .appendingPathComponent("state", isDirectory: true)
            .appendingPathComponent("openclaw.sqlite", isDirectory: false)
    }

    public static func read(stateDirectoryURL: URL) throws -> ExecApprovalsSQLiteRecord? {
        try ExecApprovalsLegacyMigrationGate.assertReady(stateDirectoryURL: stateDirectoryURL)
        let database = try self.openDatabase(stateDirectoryURL: stateDirectoryURL)
        return try database.withImmediateTransaction {
            try database.ensureCanonicalTable(.execApprovalsConfig)
            return try self.readRecord(database)
        }
    }

    public static func write(
        _ document: ExecApprovalsDocument,
        stateDirectoryURL: URL,
        updatedAtMilliseconds: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws
    {
        try self.withImmediateTransaction(
            stateDirectoryURL: stateDirectoryURL,
            updatedAtMilliseconds: updatedAtMilliseconds)
        { _ in
            ExecApprovalsSQLiteMutation(value: (), documentToWrite: document)
        }
    }

    public static func withImmediateTransaction<Value>(
        stateDirectoryURL: URL,
        updatedAtMilliseconds: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        _ body: (ExecApprovalsSQLiteRecord?) throws -> ExecApprovalsSQLiteMutation<Value>) throws -> Value
    {
        try ExecApprovalsLegacyMigrationGate.assertReady(stateDirectoryURL: stateDirectoryURL)
        let database = try self.openDatabase(stateDirectoryURL: stateDirectoryURL)
        return try database.withImmediateTransaction {
            try database.ensureCanonicalTable(.execApprovalsConfig)
            let mutation = try body(self.readRecord(database))
            if let document = mutation.documentToWrite {
                try self.assertMutationNotFenced(database)
                try self.writeRecord(
                    database,
                    document: document,
                    updatedAtMilliseconds: updatedAtMilliseconds)
            }
            return mutation.value
        }
    }

    static func decode(_ rawJSON: String) throws -> ExecApprovalsDocument {
        guard let data = rawJSON.data(using: .utf8), self.hasValidPersistedStructure(data) else {
            throw OpenClawNativeStateError("Malformed exec approvals raw_json")
        }
        let document = try JSONDecoder().decode(ExecApprovalsDocument.self, from: data)
        guard document.version == 1 else {
            throw OpenClawNativeStateError(
                "Unsupported exec approvals version \(document.version) in raw_json")
        }
        return document
    }

    public static func serialize(_ document: ExecApprovalsDocument) throws -> String {
        guard document.version == 1 else {
            throw OpenClawNativeStateError("Exec approvals document version must be 1")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(document)
        guard let rawJSON = String(data: data, encoding: .utf8) else {
            throw OpenClawNativeStateError("Could not encode exec approvals as UTF-8")
        }
        let persisted = rawJSON + "\n"
        _ = try self.decode(persisted)
        return persisted
    }

    private static func openDatabase(stateDirectoryURL: URL) throws -> OpenClawNativeStateSQLite {
        try OpenClawNativeStateSQLite(
            databaseURL: self.databaseURL(stateDirectoryURL: stateDirectoryURL),
            busyTimeoutMilliseconds: self.busyTimeoutMilliseconds)
    }

    private static func readRecord(
        _ database: OpenClawNativeStateSQLite) throws -> ExecApprovalsSQLiteRecord?
    {
        let statement = try database.prepare(
            "SELECT raw_json FROM exec_approvals_config WHERE config_key = ?")
        try statement.bindText(self.configKey, at: 1)
        guard try statement.step() == .row else { return nil }
        let rawJSON = try statement.requiredText(at: 0, field: "exec approvals raw_json")
        guard try statement.step() == .done else {
            throw OpenClawNativeStateError("Exec approvals singleton query returned multiple rows")
        }
        return try ExecApprovalsSQLiteRecord(rawJSON: rawJSON, document: self.decode(rawJSON))
    }

    private static func writeRecord(
        _ database: OpenClawNativeStateSQLite,
        document: ExecApprovalsDocument,
        updatedAtMilliseconds: Int64) throws
    {
        let rawJSON = try self.serialize(document)
        let projected = self.projectionDocument(document)
        let agents = Array((projected.agents ?? [:]).values)
        let statement = try database.prepare("""
        INSERT INTO exec_approvals_config (
          config_key, raw_json, socket_path, has_socket_token,
          default_security, default_ask, default_ask_fallback, auto_allow_skills,
          agent_count, allowlist_count, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(config_key) DO UPDATE SET
          raw_json = excluded.raw_json,
          socket_path = excluded.socket_path,
          has_socket_token = excluded.has_socket_token,
          default_security = excluded.default_security,
          default_ask = excluded.default_ask,
          default_ask_fallback = excluded.default_ask_fallback,
          auto_allow_skills = excluded.auto_allow_skills,
          agent_count = excluded.agent_count,
          allowlist_count = excluded.allowlist_count,
          updated_at_ms = excluded.updated_at_ms
        """)
        try statement.bindText(self.configKey, at: 1)
        try statement.bindText(rawJSON, at: 2)
        try self.bind(projected.socket?.path, to: statement, at: 3)
        try statement.bindInt64(projected.socket?.token?.isEmpty == false ? 1 : 0, at: 4)
        try self.bind(projected.defaults?.security?.rawValue, to: statement, at: 5)
        try self.bind(projected.defaults?.ask?.rawValue, to: statement, at: 6)
        try self.bind(projected.defaults?.askFallback?.rawValue, to: statement, at: 7)
        if let autoAllowSkills = projected.defaults?.autoAllowSkills {
            try statement.bindInt64(autoAllowSkills ? 1 : 0, at: 8)
        } else {
            try statement.bindNull(at: 8)
        }
        try statement.bindInt64(Int64(agents.count), at: 9)
        try statement.bindInt64(
            Int64(agents.reduce(0) { $0 + ($1.allowlist?.count ?? 0) }),
            at: 10)
        try statement.bindInt64(updatedAtMilliseconds, at: 11)
        guard try statement.step() == .done else {
            throw OpenClawNativeStateError("Exec approvals upsert did not complete")
        }
    }

    private static func assertMutationNotFenced(
        _ database: OpenClawNativeStateSQLite) throws
    {
        let table = try database.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'state_leases'")
        guard try table.step() == .row else { return }

        let statement = try database.prepare("""
        SELECT owner FROM state_leases
        WHERE scope = ? AND lease_key = ? AND expires_at > ?
        LIMIT 1
        """)
        try statement.bindText(self.mutationLeaseScope, at: 1)
        try statement.bindText(self.mutationLeaseKey, at: 2)
        try statement.bindInt64(Int64(Date().timeIntervalSince1970 * 1000), at: 3)
        // Expired rows intentionally do not fence writers: TTL expiry is the
        // crash-release path when the deleting process cannot remove its lease.
        guard try statement.step() != .row else {
            throw OpenClawNativeStateError(
                "Exec approvals cannot be changed while agent deletion is in progress; retry.")
        }
    }

    private static func projectionDocument(
        _ document: ExecApprovalsDocument) -> ExecApprovalsDocument
    {
        var agents = document.agents ?? [:]
        if let legacyDefault = agents.removeValue(forKey: "default") {
            if let current = agents["main"] {
                agents["main"] = self.mergeAgent(current: current, legacy: legacyDefault)
            } else {
                agents["main"] = legacyDefault
            }
        }
        for (key, var agent) in agents {
            agent.allowlist = agent.allowlist?.filter {
                !$0.pattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            agents[key] = agent
        }
        let socketPath = document.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines)
        let socketToken = document.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines)
        return ExecApprovalsDocument(
            version: 1,
            socket: ExecApprovalsSocketDocument(
                path: socketPath?.isEmpty == false ? socketPath : nil,
                token: socketToken?.isEmpty == false ? socketToken : nil),
            defaults: document.defaults,
            agents: agents)
    }

    private static func mergeAgent(
        current: ExecApprovalsAgentDocument,
        legacy: ExecApprovalsAgentDocument) -> ExecApprovalsAgentDocument
    {
        var seen = Set<String>()
        let allowlist = ((current.allowlist ?? []) + (legacy.allowlist ?? [])).filter { entry in
            let pattern = entry.pattern.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !pattern.isEmpty else { return false }
            let key = "\(pattern)\0\(entry.argPattern?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")"
            return seen.insert(key).inserted
        }
        return ExecApprovalsAgentDocument(
            security: current.security ?? legacy.security,
            ask: current.ask ?? legacy.ask,
            askFallback: current.askFallback ?? legacy.askFallback,
            autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
            allowlist: allowlist.isEmpty ? nil : allowlist)
    }

    private static func bind(
        _ value: String?,
        to statement: OpenClawNativeStateSQLiteStatement,
        at index: Int32) throws
    {
        if let value {
            try statement.bindText(value, at: index)
        } else {
            try statement.bindNull(at: index)
        }
    }

    private static func hasValidPersistedStructure(_ data: Data) -> Bool {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = root["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.doubleValue == 1
        else { return false }
        if let socket = root["socket"] {
            guard let object = socket as? [String: Any],
                  self.hasOptionalString(object, key: "path"),
                  self.hasOptionalString(object, key: "token")
            else { return false }
        }
        if let defaults = root["defaults"], !self.hasValidPolicyFields(defaults) {
            return false
        }
        if let agents = root["agents"] {
            guard let object = agents as? [String: Any] else { return false }
            for value in object.values {
                guard self.hasValidPolicyFields(value), let agent = value as? [String: Any] else {
                    return false
                }
                if let allowlist = agent["allowlist"] {
                    guard let entries = allowlist as? [Any],
                          entries.allSatisfy(self.hasValidAllowlistEntry)
                    else { return false }
                }
            }
        }
        return true
    }

    private static func hasValidAllowlistEntry(_ value: Any) -> Bool {
        if let pattern = value as? String {
            return !pattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        guard let object = value as? [String: Any],
              let pattern = object["pattern"] as? String,
              !pattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return false }
        for key in ["id", "source", "commandText", "argPattern", "lastUsedCommand", "lastResolvedPath"] {
            if let value = object[key], !(value is String) {
                return false
            }
        }
        if let lastUsedAt = object["lastUsedAt"] {
            guard let number = lastUsedAt as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite
            else { return false }
        }
        return true
    }

    private static func hasValidPolicyFields(_ value: Any) -> Bool {
        guard let object = value as? [String: Any] else { return false }
        if let security = object["security"] {
            guard let raw = security as? String, ExecApprovalsSecurity(rawValue: raw) != nil else {
                return false
            }
        }
        if let ask = object["ask"] {
            guard let raw = ask as? String, ExecApprovalsAsk(rawValue: raw) != nil else {
                return false
            }
        }
        if let fallback = object["askFallback"] {
            guard let raw = fallback as? String, ExecApprovalsSecurity(rawValue: raw) != nil else {
                return false
            }
        }
        if let autoAllowSkills = object["autoAllowSkills"], !(autoAllowSkills is Bool) {
            return false
        }
        return true
    }

    private static func hasOptionalString(_ object: [String: Any], key: String) -> Bool {
        guard let value = object[key] else { return true }
        return value is String
    }
}

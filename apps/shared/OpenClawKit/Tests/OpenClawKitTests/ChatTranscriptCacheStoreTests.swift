import Foundation
import GRDB
import OpenClawKit
import SQLite3
import Testing
@testable import OpenClawChatUI

private func makeDatabaseDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("chat-database-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

func cacheMessage(
    role: String,
    text: String,
    timestamp: Double,
    idempotencyKey: String? = nil) -> OpenClawChatMessage
{
    OpenClawChatMessage(
        role: role,
        content: [
            OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil),
        ],
        timestamp: timestamp,
        idempotencyKey: idempotencyKey)
}

func cacheSessionEntry(
    key: String,
    updatedAt: Double,
    agentID: String? = nil) -> OpenClawChatSessionEntry
{
    OpenClawChatSessionEntry(
        key: key,
        kind: nil,
        displayName: nil,
        agentId: agentID,
        surface: nil,
        subject: nil,
        room: nil,
        space: nil,
        updatedAt: updatedAt,
        sessionId: nil,
        systemSent: nil,
        abortedLastRun: nil,
        thinkingLevel: nil,
        verboseLevel: nil,
        inputTokens: nil,
        outputTokens: nil,
        totalTokens: nil,
        modelProvider: nil,
        model: nil,
        contextTokens: nil)
}

private func messageTexts(_ messages: [OpenClawChatMessage]) -> [String] {
    messages.map { $0.content.compactMap(\.text).joined() }
}

extension OpenClawChatSQLiteTranscriptCache {
    fileprivate func storeTestTranscript(
        sessionKey: String,
        agentID: String? = nil,
        messages: [OpenClawChatMessage]) async
    {
        await storeCanonicalTranscript(
            sessionKey: sessionKey,
            agentID: agentID,
            messages: messages,
            canonicalMessageIdempotencyKeys: Set(messages.compactMap(\.idempotencyKey)))
    }
}

private struct CacheMessageRowProbe: Sendable {
    let position: Int
    let idempotencyKey: String?
    let payloadJSON: String
}

private func outboxCommand(
    id: String = UUID().uuidString,
    sessionKey: String = "main",
    text: String,
    attachments: [OpenClawChatOutboxAttachment] = [],
    thinking: String = "off",
    createdAt: Double = Date().timeIntervalSince1970,
    status: OpenClawChatOutboxCommand.Status = .queued) -> OpenClawChatOutboxCommand
{
    OpenClawChatOutboxCommand(
        id: id,
        sessionKey: sessionKey,
        deliverySessionKey: "agent:main:main",
        routingContract: "per-sender|main|main",
        agentID: "main",
        text: text,
        attachments: attachments,
        thinking: thinking,
        createdAt: createdAt,
        status: status,
        retryCount: 0,
        lastError: nil)
}

private func withRawDatabase(at url: URL, _ body: (OpaquePointer) throws -> Void) throws {
    var raw: OpaquePointer?
    #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
    let database = try #require(raw)
    defer { sqlite3_close_v2(database) }
    try body(database)
}

private func execute(_ database: OpaquePointer, _ sql: String) {
    #expect(sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK)
}

private func createLegacyV2Database(
    at url: URL,
    gatewayID: String,
    commandID: String,
    text: String = "preserve me") throws
{
    try withRawDatabase(at: url) { raw in
        execute(raw, """
        CREATE TABLE outbox_commands(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_uuid TEXT NOT NULL UNIQUE,
            gateway_id TEXT NOT NULL,
            session_key TEXT NOT NULL,
            text TEXT NOT NULL,
            thinking TEXT NOT NULL,
            created_at REAL NOT NULL,
            status TEXT NOT NULL,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT ''
        );
        INSERT INTO outbox_commands(
            client_uuid, gateway_id, session_key, text, thinking,
            created_at, status, retry_count, last_error
        ) VALUES ('\(commandID)', '\(gatewayID)', 'main', '\(text)', 'off', 1, 'queued', 2, '');
        PRAGMA user_version = 2;
        """)
    }
}

class TemporaryDatabaseTestSuite {
    let directory: URL

    required init() throws {
        self.directory = try makeDatabaseDirectory()
    }

    fileprivate init(directory: URL) {
        self.directory = directory
    }

    deinit { try? FileManager.default.removeItem(at: self.directory) }
}

class ClientDatabaseTestSuite: TemporaryDatabaseTestSuite {
    let databases: OpenClawClientDatabases
    let store: OpenClawChatSQLiteTranscriptCache

    required init() throws {
        let directory = try makeDatabaseDirectory()
        let databases: OpenClawClientDatabases
        do {
            databases = try OpenClawClientDatabases(directoryURL: directory)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
        self.databases = databases
        self.store = databases.store(gatewayID: "gw-a")
        super.init(directory: directory)
    }

    deinit { try? self.databases.close() }
}

private func retryExpectation(_ command: OpenClawChatOutboxCommand) -> OpenClawChatOutboxRetryExpectation {
    OpenClawChatOutboxRetryExpectation(
        attemptVersion: command.attemptVersion,
        retryCount: command.retryCount,
        lastError: command.lastError)
}

private func forgottenGatewayProbe(
    in databases: OpenClawClientDatabases,
    identity: String) async throws -> (hash: String?, gatewayID: String?, cleanupPhase: Int?)
{
    try await databases.stateQueue.read { db in
        let row = try Row.fetchOne(
            db,
            sql: "SELECT gateway_hash, gateway_id, cleanup_phase FROM forgotten_gateways WHERE gateway_hash = ?",
            arguments: [OpenClawClientDatabases.gatewayIdentityHash(identity)])
        return (row?["gateway_hash"], row?["gateway_id"], row?["cleanup_phase"])
    }
}

extension OpenClawChatSQLiteTranscriptCache {
    fileprivate func reconcileForTest(
        _ scope: OpenClawChatOutboxScope,
        previousState: OpenClawChatOutboxBranchState,
        activeLeafEntryID: String? = "leaf-b",
        branchLeafEntryIDs: Set<String> = ["leaf-b"]) async -> [OpenClawChatOutboxCommand]?
    {
        await reconcileBranchScope(
            scope,
            previousState: previousState,
            activeLeafEntryID: activeLeafEntryID,
            branchLeafEntryIDs: branchLeafEntryIDs,
            lastError: "branch changed")
    }
}

final class ChatTranscriptCacheStoreTests: ClientDatabaseTestSuite, @unchecked Sendable {
    @Test func `one installation owns exactly the two named databases`() throws {
        let sqliteFiles = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasSuffix(".sqlite") }
            .sorted()
        #expect(sqliteFiles == ["client-state.sqlite", "gateway-cache.sqlite"])
    }

    @Test func `full removal deletes both databases legacy files and sidecars`() async throws {
        await databases.store(gatewayID: "gw-a").storeSessions([
            cacheSessionEntry(key: "main", updatedAt: 1),
        ])
        let legacyURL = directory.appendingPathComponent("chat-cache.sqlite")
        try withRawDatabase(at: legacyURL) { raw in
            execute(raw, "PRAGMA user_version = 99;")
        }
        try Data("sidecar".utf8).write(to: URL(fileURLWithPath: legacyURL.path + "-wal"))
        try databases.close()

        try OpenClawClientDatabases.removeDatabaseFiles(in: directory)

        for filename in [
            OpenClawClientDatabases.gatewayCacheFilename,
            OpenClawClientDatabases.clientStateFilename,
            legacyURL.lastPathComponent,
        ] {
            for suffix in ["", "-wal", "-shm", "-journal"] {
                #expect(!FileManager.default.fileExists(
                    atPath: directory.appendingPathComponent(filename).path + suffix))
            }
        }
    }

    @Test func `transcript and sessions round trip as row JSON`() async throws {
        let messages = [
            cacheMessage(role: "user", text: "hello", timestamp: 1000, idempotencyKey: "run-1:user"),
            cacheMessage(role: "assistant", text: "hi", timestamp: 2000, idempotencyKey: "run-1"),
        ]

        await store.storeTestTranscript(sessionKey: "main", messages: messages)
        await store.storeSessions([cacheSessionEntry(key: "main", updatedAt: 2000)])

        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["hello", "hi"])
        #expect(await store.loadSessions().map(\.key) == ["main"])
        let messageRows = try await databases.cacheQueue.read { db in
            try Row.fetchAll(db, sql: """
            SELECT position, timestamp_ms, idempotency_key, payload_json
            FROM cached_messages WHERE gateway_id = 'gw-a' ORDER BY position
            """).map { row in
                CacheMessageRowProbe(
                    position: row["position"],
                    idempotencyKey: row["idempotency_key"],
                    payloadJSON: row["payload_json"])
            }
        }
        #expect(messageRows.count == 2)
        #expect(messageRows.map(\.position) == [0, 1])
        #expect(messageRows.map(\.idempotencyKey) == ["run-1:user", "run-1"])
        #expect(messageRows[0].payloadJSON.contains("\"role\":\"user\""))
        #expect(!messageRows[0].payloadJSON.hasPrefix("["))
    }

    @Test func `agent session snapshots preserve another agents offline roster`() async throws {
        await store.storeSessions([
            cacheSessionEntry(key: "global", updatedAt: 1, agentID: "agent-a"),
        ], agentID: "agent-a")
        await store.storeSessions([
            cacheSessionEntry(key: "global", updatedAt: 2, agentID: "agent-b"),
        ], agentID: "agent-b")

        #expect(await store.loadSessions(agentID: "agent-a").map(\.agentId) == ["agent-a"])
        #expect(await store.loadSessions(agentID: "agent-b").map(\.agentId) == ["agent-b"])
        try databases.close()

        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        #expect(await reopened.store(gatewayID: "gw-a").loadSessions(agentID: "agent-a").map(\.agentId) == [
            "agent-a",
        ])
        #expect(await reopened.store(gatewayID: "gw-a").loadSessions(agentID: "agent-b").map(\.agentId) == [
            "agent-b",
        ])
    }

    @Test func `empty or rejected agent snapshot cannot erase another roster`() async {
        await store.storeSessions([
            cacheSessionEntry(key: "global", updatedAt: 1, agentID: "agent-a"),
        ], agentID: "agent-a")
        await store.storeSessions([
            cacheSessionEntry(key: "global", updatedAt: 2, agentID: "agent-b"),
        ], agentID: "agent-b")

        await store.storeSessions([
            cacheSessionEntry(key: "agent:agent-a:main", updatedAt: 3, agentID: "agent-a"),
        ], agentID: "agent-b")

        #expect(await store.loadSessions(agentID: "agent-a").map(\.agentId) == ["agent-a"])
        #expect(await store.loadSessions(agentID: "agent-b").map(\.agentId) == ["agent-b"])

        await store.storeSessions([], agentID: "agent-b")

        #expect(await store.loadSessions(agentID: "agent-a").map(\.agentId) == ["agent-a"])
        #expect(await store.loadSessions(agentID: "agent-b").isEmpty)
    }

    @Test func `agent session owner partitions remain bounded`() async throws {
        for index in 0...OpenClawChatSQLiteTranscriptCache.maxCachedSessionOwners {
            let agentID = "agent-\(index)"
            await store.storeSessions([
                cacheSessionEntry(key: "global", updatedAt: Double(index), agentID: agentID),
            ], agentID: agentID)
        }

        let counts = try await databases.cacheQueue.read { db in
            try (
                Int.fetchOne(db, sql: "SELECT COUNT(*) FROM cached_session_rosters WHERE gateway_id = 'gw-a'"),
                Int.fetchOne(db, sql: "SELECT COUNT(*) FROM cached_agent_sessions WHERE gateway_id = 'gw-a'"))
        }
        #expect(counts.0 == OpenClawChatSQLiteTranscriptCache.maxCachedSessionOwners)
        #expect(counts.1 == OpenClawChatSQLiteTranscriptCache.maxCachedSessionOwners)
    }

    @Test func `agent snapshot discards legacy roster without touching transcripts`() async throws {
        await store.storeTestTranscript(
            sessionKey: "global",
            agentID: "agent-a",
            messages: [cacheMessage(role: "assistant", text: "preserved", timestamp: 1)])
        try await databases.cacheQueue.write { db in
            try db.execute(
                sql: """
                INSERT INTO cached_sessions(gateway_id, session_key, position, updated_at, payload_json)
                VALUES ('gw-a', 'global', 0, 1, '{}')
                """)
        }

        await store.storeSessions([
            cacheSessionEntry(key: "global", updatedAt: 2, agentID: "agent-a"),
        ], agentID: "agent-a")

        #expect(try await databases.cacheQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM cached_sessions WHERE gateway_id = 'gw-a'")
        } == 0)
        #expect(await messageTexts(store.loadTranscript(sessionKey: "global", agentID: "agent-a")) == ["preserved"])
    }

    @Test func `cache format mismatch rebuilds without touching client state`() async throws {
        let stateIdentity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "per-sender",
            mainSessionKey: "main",
            defaultAgentID: "main"))
        await store.storeSessionRoutingIdentity(stateIdentity)
        try databases.close()
        let cacheURL = directory.appendingPathComponent("gateway-cache.sqlite")
        try withRawDatabase(at: cacheURL) { raw in
            execute(raw, "UPDATE cache_metadata SET format_version = 999 WHERE id = 1")
            execute(raw, "CREATE TABLE disposable_old_shape(value TEXT)")
        }

        let reopened = try OpenClawClientDatabases(directoryURL: directory)

        #expect(reopened.loadSessionRoutingIdentity(gatewayID: "gw-a") == stateIdentity)
        #expect(try await reopened.cacheQueue.read { db in try db.tableExists("disposable_old_shape") } == false)
        #expect(try await reopened.cacheQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT format_version FROM cache_metadata WHERE id = 1")
        } == 1)
    }

    @Test func `corrupt cache rebuilds while corrupt client state is preserved`() async throws {
        let cacheDirectory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: cacheDirectory) }
        let cacheURL = cacheDirectory.appendingPathComponent("gateway-cache.sqlite")
        try Data("not sqlite".utf8).write(to: cacheURL)
        let repaired = try OpenClawClientDatabases(directoryURL: cacheDirectory)
        #expect(try await repaired.cacheQueue.read { db in try db.tableExists("cached_messages") })

        let stateDirectory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: stateDirectory) }
        let stateURL = stateDirectory.appendingPathComponent("client-state.sqlite")
        let bytes = Data("durable bytes must survive".utf8)
        try bytes.write(to: stateURL)
        #expect(throws: (any Error).self) {
            _ = try OpenClawClientDatabases(directoryURL: stateDirectory)
        }
        #expect(try Data(contentsOf: stateURL) == bytes)
    }

    @Test func `transcripts are scoped by gateway and agent in one cache`() async {
        let storeA = databases.store(gatewayID: "gw-a")
        let storeB = databases.store(gatewayID: "gw-b")

        await storeA.storeTestTranscript(
            sessionKey: "global",
            agentID: "agent-a",
            messages: [cacheMessage(role: "user", text: "A", timestamp: 1)])
        await storeA.storeTestTranscript(
            sessionKey: "global",
            agentID: "agent-b",
            messages: [cacheMessage(role: "user", text: "B", timestamp: 2)])
        await storeB.storeTestTranscript(
            sessionKey: "global",
            agentID: "agent-a",
            messages: [cacheMessage(role: "user", text: "other gateway", timestamp: 3)])

        #expect(await messageTexts(storeA.loadTranscript(sessionKey: "global", agentID: "agent-a")) == ["A"])
        #expect(await messageTexts(storeA.loadTranscript(sessionKey: "global", agentID: "agent-b")) == ["B"])
        #expect(await messageTexts(storeB.loadTranscript(sessionKey: "global", agentID: "agent-a")) == [
            "other gateway",
        ])
        #expect(await storeA.loadTranscript(sessionKey: "global").isEmpty)
    }

    @Test func `cache bounds sessions messages and transcript partitions`() async {
        let sessions = (0..<(OpenClawChatSQLiteTranscriptCache.maxCachedSessions + 10)).map {
            cacheSessionEntry(key: "s\($0)", updatedAt: Double($0))
        }
        await store.storeSessions(sessions)
        #expect(await store.loadSessions().count == OpenClawChatSQLiteTranscriptCache.maxCachedSessions)
        #expect(await store.loadSessions().contains(where: { $0.key == "s0" }) == false)

        let messages = (0..<(OpenClawChatSQLiteTranscriptCache.maxCachedMessagesPerSession + 20)).map {
            cacheMessage(role: "user", text: "m\($0)", timestamp: Double($0))
        }
        await store.storeTestTranscript(sessionKey: "bounded", messages: messages)
        #expect(await store.loadTranscript(sessionKey: "bounded").count ==
            OpenClawChatSQLiteTranscriptCache.maxCachedMessagesPerSession)
        #expect(await messageTexts(store.loadTranscript(sessionKey: "bounded")).first == "m20")

        for index in 0...OpenClawChatSQLiteTranscriptCache.maxCachedTranscripts {
            await store.storeTestTranscript(
                sessionKey: "partition-\(index)",
                messages: [cacheMessage(role: "user", text: "p\(index)", timestamp: Double(index))])
        }
        #expect(await store.loadTranscript(sessionKey: "partition-0").isEmpty)
        #expect(await store.loadTranscript(
            sessionKey: "partition-\(OpenClawChatSQLiteTranscriptCache.maxCachedTranscripts)").isEmpty == false)
    }

    @Test func `empty transcript deletes its partition`() async throws {
        await store.storeTestTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "old", timestamp: 1)])
        await store.storeTestTranscript(sessionKey: "main", messages: [])

        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
        #expect(try await databases.cacheQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM cached_transcripts")
        } == 0)
    }

    @Test func `canonical cache excludes optimistic outbox rows`() async {
        #expect(await store.enqueueCommand(outboxCommand(id: "queued", text: "local")))
        let snapshot = [
            cacheMessage(role: "user", text: "local", timestamp: 1, idempotencyKey: "queued:user"),
            cacheMessage(role: "assistant", text: "canonical", timestamp: 2, idempotencyKey: "other"),
        ]

        await store.storeCanonicalTranscript(
            sessionKey: "main",
            agentID: nil,
            messages: snapshot,
            canonicalMessageIdempotencyKeys: ["other"])
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["canonical"])
        #expect(await store.loadCommands().map(\.id) == ["queued"])

        await store.storeCanonicalTranscript(
            sessionKey: "main",
            agentID: nil,
            messages: snapshot,
            canonicalMessageIdempotencyKeys: ["queued:user", "other"])
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["local", "canonical"])
    }

    @Test func `canceled optimistic row cannot reenter cache from a stale snapshot`() async {
        #expect(await store.enqueueCommand(outboxCommand(id: "canceled", text: "local")))
        let capturedBeforeCancellation = [
            cacheMessage(role: "user", text: "local", timestamp: 1, idempotencyKey: "canceled:user"),
        ]

        #expect(await store.cancelCommand(id: "canceled") == .updated)
        await store.storeCanonicalTranscript(
            sessionKey: "main",
            agentID: nil,
            messages: capturedBeforeCancellation,
            canonicalMessageIdempotencyKeys: [])

        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
    }

    @Test func `malformed cache partitions are discarded atomically`() async throws {
        await store.storeSessions([
            cacheSessionEntry(key: "global", updatedAt: 1, agentID: "agent-a"),
        ], agentID: "agent-a")
        await store.storeSessions([
            cacheSessionEntry(key: "global", updatedAt: 2, agentID: "agent-b"),
        ], agentID: "agent-b")
        await store.storeTestTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "assistant", text: "cached", timestamp: 1)])
        try await databases.cacheQueue.write { db in
            try db.execute(
                sql: """
                UPDATE cached_agent_sessions SET payload_json = 'not-json'
                WHERE gateway_id = 'gw-a' AND agent_id = 'agent-a'
                """)
            try db.execute(
                sql: "UPDATE cached_messages SET payload_json = 'not-json' WHERE gateway_id = 'gw-a'")
        }

        #expect(await store.loadSessions(agentID: "agent-a").isEmpty)
        #expect(await store.loadSessions(agentID: "agent-b").map(\.agentId) == ["agent-b"])
        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
        #expect(try await databases.cacheQueue.read { db in
            try Int.fetchOne(db, sql: """
            SELECT COUNT(*) FROM cached_agent_sessions
            WHERE gateway_id = 'gw-a' AND agent_id = 'agent-a'
            """)
        } == 0)
        #expect(try await databases.cacheQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM cached_transcripts WHERE gateway_id = 'gw-a'")
        } == 0)
    }

    @Test func `canonical merge preserves newer cache rows`() async {
        await store.storeTestTranscript(sessionKey: "main", messages: [
            cacheMessage(role: "assistant", text: "newer", timestamp: 2, idempotencyKey: "newer"),
        ])
        await store.mergeCanonicalTranscriptMessage(
            sessionKey: "main",
            agentID: nil,
            message: cacheMessage(role: "user", text: "confirmed", timestamp: 1, idempotencyKey: "confirmed:user"),
            canonicalMessageIdempotencyKey: "confirmed:user")
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["confirmed", "newer"])
    }

    @Test func `concurrent canonical merges do not lose messages`() async {
        await withTaskGroup(of: Void.self) { group in
            for index in 0..<20 {
                group.addTask {
                    let key = "merge-\(index)"
                    await self.store.mergeCanonicalTranscriptMessage(
                        sessionKey: "main",
                        agentID: nil,
                        message: cacheMessage(
                            role: "assistant",
                            text: key,
                            timestamp: Double(index),
                            idempotencyKey: key),
                        canonicalMessageIdempotencyKey: key)
                }
            }
        }

        #expect(await Set(messageTexts(store.loadTranscript(sessionKey: "main"))) ==
            Set((0..<20).map { "merge-\($0)" }))
    }

    @Test func `cache projection strips payloads and keeps bounded diffs`() throws {
        let oversizedDiff = "+1 " + String(repeating: "x", count: 64100)
        let message = OpenClawChatMessage(
            role: "toolResult",
            content: [
                OpenClawChatMessageContent(
                    type: "toolCall",
                    text: "done",
                    mimeType: "image/jpeg",
                    fileName: "photo.jpg",
                    content: AnyCodable(String(repeating: "payload", count: 1000)),
                    name: "apply_patch",
                    arguments: AnyCodable([
                        "input": AnyCodable(oversizedDiff),
                        "ignored": AnyCodable("drop"),
                    ]),
                    details: AnyCodable(["diff": AnyCodable(oversizedDiff), "ignored": AnyCodable("drop")])),
            ],
            timestamp: 1,
            details: AnyCodable(["diff": AnyCodable(oversizedDiff), "ignored": AnyCodable("drop")]),
            provenance: OpenClawChatInputProvenance(
                kind: "internal_system",
                sourceTool: "restart-sentinel"),
            historyMarker: OpenClawChatHistoryMarker(
                kind: "compaction",
                id: "compact-cache",
                tokensBefore: 12000,
                tokensAfter: 7000))

        let cached = try #require(OpenClawChatSQLiteTranscriptCache.cacheableMessages([message]).first)
        #expect(cached.content[0].content == nil)
        #expect(cached.content[0].thinkingSignature == nil)
        #expect(Set(cached.content[0].arguments?.dictionaryValue?.keys.map(\.self) ?? []) == ["input"])
        #expect(cached.content[0].arguments?.dictionaryValue?["input"]?.stringValue?.utf16.count == 64000)
        #expect(Set(cached.details?.dictionaryValue?.keys.map(\.self) ?? []) == ["diff"])
        #expect(cached.provenance == message.provenance)
        #expect(cached.historyMarker == message.historyMarker)
    }

    @Test func `gateway removal deletes only that gateways cache and state`() async throws {
        let storeA = databases.store(gatewayID: "gw-a")
        let storeB = databases.store(gatewayID: "gw-b")
        await storeA.storeSessions([cacheSessionEntry(key: "a", updatedAt: 1)])
        await storeB.storeSessions([cacheSessionEntry(key: "b", updatedAt: 2)])
        #expect(await storeA.enqueueCommand(outboxCommand(id: "a", text: "A")))
        #expect(await storeB.enqueueCommand(outboxCommand(id: "b", text: "B")))

        try databases.removeGatewayData(gatewayID: "gw-a")

        #expect(await storeA.loadSessions().isEmpty)
        #expect(await storeA.loadCommands().isEmpty)
        #expect(await storeB.loadSessions().map(\.key) == ["b"])
        #expect(await storeB.loadCommands().map(\.id) == ["b"])
    }

    @Test func `staged gateway removal reconciles against the pairing registry`() async throws {
        await store.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])
        #expect(await store.enqueueCommand(outboxCommand(id: "keep", text: "pending")))
        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        #expect(await store.loadSessions().map(\.key) == ["main"])
        #expect(await store.loadCommands().map(\.id) == ["keep"])
        try databases.close()

        let registered = try OpenClawClientDatabases(
            directoryURL: directory,
            registeredGatewayIDs: ["gw-a"])
        #expect(await registered.store(gatewayID: "gw-a").loadCommands().map(\.id) == ["keep"])
        try registered.stageGatewayRemoval(gatewayID: "gw-a")
        try registered.close()

        let forgotten = try OpenClawClientDatabases(
            directoryURL: directory,
            registeredGatewayIDs: [])
        #expect(await forgotten.store(gatewayID: "gw-a").loadSessions().isEmpty)
        #expect(await forgotten.store(gatewayID: "gw-a").loadCommands().isEmpty)
        let probe = try await forgottenGatewayProbe(in: forgotten, identity: "gw-a")
        #expect(probe.hash == OpenClawClientDatabases.gatewayIdentityHash("gw-a") && probe.gatewayID == nil)
    }

    @Test func `staged gateway removal uses exact registry identifier bytes`() async throws {
        let composedGatewayID = "gateway-\u{00E9}"
        let decomposedGatewayID = "gateway-e\u{0301}"
        #expect(composedGatewayID == decomposedGatewayID)
        let store = databases.store(gatewayID: composedGatewayID)
        #expect(await store.enqueueCommand(outboxCommand(id: "remove", text: "pending")))
        try databases.stageGatewayRemoval(gatewayID: composedGatewayID)
        try databases.close()

        let recovered = try OpenClawClientDatabases(
            directoryURL: directory,
            registeredGatewayIDs: [decomposedGatewayID])

        #expect(await recovered.store(gatewayID: composedGatewayID).loadCommands().isEmpty)
        let probe = try await forgottenGatewayProbe(in: recovered, identity: composedGatewayID)
        #expect(probe.hash == OpenClawClientDatabases.gatewayIdentityHash(composedGatewayID) && probe.gatewayID == nil)
    }

    @Test func `commit started recovery finishes even while gateway remains registered`() async throws {
        await store.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])
        #expect(await store.enqueueCommand(outboxCommand(id: "remove", text: "pending")))
        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        // Simulate termination after the irreversible transaction, before cache cleanup and tombstone finalization.
        try await databases.stateQueue.write { db in
            try db.execute(
                sql: "UPDATE forgotten_gateways SET cleanup_phase = 2 WHERE gateway_id = ?",
                arguments: ["gw-a"])
            try db.execute(
                sql: "DELETE FROM outbox_commands WHERE gateway_id = ?",
                arguments: ["gw-a"])
        }
        try databases.close()

        let recovered = try OpenClawClientDatabases(
            directoryURL: directory,
            registeredGatewayIDs: ["gw-a"])
        #expect(await recovered.store(gatewayID: "gw-a").loadSessions().isEmpty)
        #expect(await recovered.store(gatewayID: "gw-a").loadCommands().isEmpty)
        let probe = try await forgottenGatewayProbe(in: recovered, identity: "gw-a")
        #expect(probe.cleanupPhase == 0)
    }

    @Test func `hash only scrub marker remains recoverable`() async throws {
        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        try await databases.stateQueue.write { db in
            try db.execute(
                sql: """
                UPDATE forgotten_gateways
                SET gateway_id = NULL, cleanup_phase = 3, restore_finalized = 0
                WHERE gateway_id = ?
                """,
                arguments: ["gw-a"])
        }
        try databases.close()

        let recovered = try OpenClawClientDatabases(directoryURL: directory)
        let probe = try await forgottenGatewayProbe(in: recovered, identity: "gw-a")
        #expect(probe.cleanupPhase == 0)
    }

    @Test func `unknown registry preserves a cancelable staged removal`() async throws {
        #expect(await store.enqueueCommand(outboxCommand(id: "keep", text: "pending")))
        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        try databases.close()

        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        #expect(await reopened.store(gatewayID: "gw-a").loadCommands().map(\.id) == ["keep"])
        let probe = try await forgottenGatewayProbe(in: reopened, identity: "gw-a")
        #expect(probe.cleanupPhase == 1)
    }

    @Test func `pending removal marker gates writable facade recreation`() throws {
        #expect(!databases.hasPendingGatewayRemoval(gatewayID: "gw-a"))
        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        #expect(databases.hasPendingGatewayRemoval(gatewayID: "gw-a"))
        try databases.cancelGatewayRemoval(gatewayID: "gw-a")
        #expect(!databases.hasPendingGatewayRemoval(gatewayID: "gw-a"))
    }

    @Test func `cancelable stage does not suppress legacy state import`() async throws {
        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        let legacyURL = directory.appendingPathComponent("chat-cache.sqlite")
        try createLegacyV2Database(at: legacyURL, gatewayID: "gw-a", commandID: "restore-on-cancel")

        databases.retryLegacyImport()

        #expect(await databases.store(gatewayID: "gw-a").loadCommands().map(\.id) == ["restore-on-cancel"])
        #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
    }

    @Test func `one broken pending removal does not block another gateway`() async throws {
        let store = databases.store(gatewayID: "z-good")
        await store.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])
        #expect(await store.enqueueCommand(outboxCommand(id: "remove", text: "pending")))
        try databases.stageGatewayRemoval(gatewayID: "z-good")
        try await databases.stateQueue.write { db in
            try db.execute(
                sql: "UPDATE forgotten_gateways SET cleanup_phase = 2 WHERE gateway_id = ?",
                arguments: ["z-good"])
            try db.execute(
                sql: """
                INSERT INTO forgotten_gateways(
                    gateway_hash, gateway_id, forgotten_at, cleanup_phase, restore_finalized
                ) VALUES (?, ?, 0, 2, 0)
                """,
                arguments: [String(repeating: "0", count: 64), "a-broken"])
        }
        try databases.close()

        let recovered = try OpenClawClientDatabases(
            directoryURL: directory,
            registeredGatewayIDs: [])
        #expect(await recovered.store(gatewayID: "z-good").loadSessions().isEmpty)
        #expect(await recovered.store(gatewayID: "z-good").loadCommands().isEmpty)
        #expect(try await recovered.stateQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT cleanup_phase FROM forgotten_gateways WHERE gateway_id = ?",
                arguments: ["a-broken"])
        } == 2)
    }

    @Test func `canceling a repeated forget preserves the finalized tombstone`() async throws {
        try databases.removeGatewayData(gatewayID: "gw-a")

        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        try databases.cancelGatewayRemoval(gatewayID: "gw-a")

        let probe = try await forgottenGatewayProbe(in: databases, identity: "gw-a")
        #expect(probe.gatewayID == nil)
        #expect(probe.cleanupPhase == 0)

        let legacyURL = directory.appendingPathComponent("chat-cache.sqlite")
        try createLegacyV2Database(at: legacyURL, gatewayID: "gw-a", commandID: "must-not-return")
        databases.retryLegacyImport(registeredGatewayIDs: [])
        #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
        #expect(await databases.store(gatewayID: "gw-a").loadCommands().isEmpty)
    }

    @Test func `gateway removal scrubs its payloads from shared database files`() async throws {
        let storeA = databases.store(gatewayID: "gw-a")
        let storeB = databases.store(gatewayID: "gw-b")
        let sensitiveText = "forgotten-sensitive-\(UUID().uuidString)"
        let sensitiveBytes = Data(sensitiveText.utf8)
        let attachment = OpenClawChatOutboxAttachment(
            type: "file",
            mimeType: "application/octet-stream",
            fileName: "secret.bin",
            data: sensitiveBytes)
        await storeA.storeTestTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: sensitiveText, timestamp: 1)])
        #expect(await storeA.enqueueCommand(outboxCommand(
            id: "sensitive",
            text: sensitiveText,
            attachments: [attachment])))
        try await databases.watchMessages.importLegacy(.init(messages: [
            .init(id: "watch-sensitive", gatewayStableID: "gw-a", text: sensitiveText, submittedAtMs: nil),
        ], recentMessageIDs: []), nowMs: Int64(Date().timeIntervalSince1970 * 1000))
        await storeB.storeSessions([cacheSessionEntry(key: "keep", updatedAt: 1)])

        try databases.removeGatewayData(gatewayID: "gw-a")
        try databases.close()

        let files = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil)
        for file in files where file.lastPathComponent.contains(".sqlite") {
            #expect(try Data(contentsOf: file).range(of: sensitiveBytes) == nil)
        }
        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        #expect(await reopened.store(gatewayID: "gw-b").loadSessions().map(\.key) == ["keep"])
    }

    @Test func `routing identity survives a cold container reopen`() async throws {
        let identity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: " Per-Sender ",
            mainSessionKey: " Work ",
            defaultAgentID: " Main "))
        await databases.store(gatewayID: "gw-a").storeSessionRoutingIdentity(identity)
        try databases.close()

        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        #expect(reopened.loadSessionRoutingIdentity(gatewayID: "gw-a") == identity)
        #expect(identity.contract == "per-sender|work|main")
        #expect(try await reopened.stateQueue.read { db in
            try String.fetchAll(db, sql: "SELECT identifier FROM grdb_migrations")
        } == [
            "client-state-v1",
            "client-state-branch-ownership-v2",
            "client-state-branch-revision-v3",
            "client-state-agent-id-v4",
            "client-state-outbox-attempt-scope-v5",
            "client-state-outbox-attachment-rekey-v6",
            "client-state-outbox-settings-expectation-v7",
            "client-state-outbox-settings-claim-v8",
            "client-state-watch-message-journal-v9",
            "client-state-watch-message-legacy-receipts-v1",
        ])
    }
}

final class ClientDatabaseLegacyImportTests: TemporaryDatabaseTestSuite, @unchecked Sendable {
    @Test func `legacy v1 cache is discarded`() async throws {
        let legacyURL = directory.appendingPathComponent("chat-cache.sqlite")
        try withRawDatabase(at: legacyURL) { raw in
            execute(raw, """
            CREATE TABLE cached_sessions(
                gateway_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at REAL NOT NULL
            );
            PRAGMA user_version = 1;
            """)
        }

        let databases = try OpenClawClientDatabases(directoryURL: directory)

        #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
        #expect(try await databases.stateQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM outbox_commands")
        } == 0)
    }

    @Test func `legacy v2 outbox imports parked into client state`() async throws {
        let legacyURL = directory.appendingPathComponent(
            String(repeating: "a", count: 64) + ".sqlite")
        try createLegacyV2Database(at: legacyURL, gatewayID: "gw-a", commandID: "legacy-v2")

        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let commands = await databases.store(gatewayID: "gw-a").loadCommands()

        #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
        #expect(commands.map(\.id) == ["legacy-v2"])
        #expect(commands.map(\.text) == ["preserve me"])
        #expect(commands.map(\.status) == [.failed])
        #expect(commands.map(\.lastError) == [OpenClawChatSQLiteTranscriptCache.outboxUnknownTargetError])
        #expect(commands.map(\.routingContract) == [nil])
    }

    @Test func `foreground retry imports a legacy database discovered after startup`() async throws {
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let legacyURL = directory.appendingPathComponent("chat-cache.sqlite")
        try createLegacyV2Database(at: legacyURL, gatewayID: "gw-a", commandID: "late-legacy")

        databases.retryLegacyImport()

        #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
        #expect(await databases.store(gatewayID: "gw-a").loadCommands().map(\.id) == ["late-legacy"])
    }

    @Test func `forgotten gateway is never resurrected by a late legacy import`() async throws {
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        try databases.removeGatewayData(gatewayID: "gw-forgotten")
        let legacyURL = directory.appendingPathComponent("chat-cache.sqlite")
        try createLegacyV2Database(
            at: legacyURL,
            gatewayID: "gw-forgotten",
            commandID: "must-not-return")

        databases.retryLegacyImport(registeredGatewayIDs: [])

        #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
        let store = databases.store(gatewayID: "gw-forgotten")
        #expect(await store.loadCommands().isEmpty)
        let probe = try await forgottenGatewayProbe(in: databases, identity: "gw-forgotten")
        #expect(probe.cleanupPhase == 0)

        #expect(await store.enqueueCommand(outboxCommand(id: "after-repair", text: "new pairing")))
        databases.retryLegacyImport()
        #expect(await store.loadCommands().map(\.id) == ["after-repair"])
    }

    @Test func `forget removes an unreadable per gateway legacy database and sidecars`() throws {
        let databaseDirectory = directory.appendingPathComponent("databases", isDirectory: true)
        let legacyDirectory = directory.appendingPathComponent("chat-cache", isDirectory: true)
        try FileManager.default.createDirectory(at: legacyDirectory, withIntermediateDirectories: true)
        let gatewayID = "manual|forgotten-secret.example|443"
        let legacyURL = OpenClawClientDatabases.legacyPerGatewayDatabaseURL(
            gatewayID: gatewayID,
            directoryURL: legacyDirectory)
        try withRawDatabase(at: legacyURL) { raw in
            execute(raw, "PRAGMA user_version = 99;")
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            try Data("legacy-sensitive-bytes".utf8).write(to: URL(fileURLWithPath: legacyURL.path + suffix))
        }
        let databases = try OpenClawClientDatabases(
            directoryURL: databaseDirectory,
            legacyDirectoryURLs: [legacyDirectory])
        #expect(FileManager.default.fileExists(atPath: legacyURL.path))

        try databases.removeGatewayData(gatewayID: gatewayID)

        for suffix in ["", "-wal", "-shm", "-journal"] {
            #expect(!FileManager.default.fileExists(atPath: legacyURL.path + suffix))
        }
        #expect(try databases.stateQueue.read { db in
            try String.fetchOne(
                db,
                sql: "SELECT gateway_hash FROM forgotten_gateways WHERE gateway_id IS NULL")
        } == OpenClawClientDatabases.gatewayIdentityHash(gatewayID))
        try databases.close()
        for suffix in ["", "-wal", "-shm"] {
            let url = URL(fileURLWithPath: databaseDirectory
                .appendingPathComponent(OpenClawClientDatabases.clientStateFilename).path + suffix)
            if FileManager.default.fileExists(atPath: url.path) {
                #expect(try Data(contentsOf: url).range(of: Data(gatewayID.utf8)) == nil)
            }
        }
    }

    @Test func `legacy import accepts only gateways in the pairing registry`() async throws {
        let keptURL = OpenClawClientDatabases.legacyPerGatewayDatabaseURL(
            gatewayID: "gw-kept",
            directoryURL: directory)
        let orphanedURL = OpenClawClientDatabases.legacyPerGatewayDatabaseURL(
            gatewayID: "gw-orphaned",
            directoryURL: directory)
        try createLegacyV2Database(at: keptURL, gatewayID: "gw-kept", commandID: "kept")
        try createLegacyV2Database(at: orphanedURL, gatewayID: "gw-orphaned", commandID: "orphaned")

        let databases = try OpenClawClientDatabases(
            directoryURL: directory,
            registeredGatewayIDs: ["gw-kept"])

        #expect(await databases.store(gatewayID: "gw-kept").loadCommands().map(\.id) == ["kept"])
        #expect(await databases.store(gatewayID: "gw-orphaned").loadCommands().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: keptURL.path))
        #expect(FileManager.default.fileExists(atPath: orphanedURL.path))
    }

    @Test func `legacy import uses exact registry identifier bytes`() async throws {
        let composedGatewayID = "gateway-\u{00E9}"
        let decomposedGatewayID = "gateway-e\u{0301}"
        #expect(composedGatewayID == decomposedGatewayID)
        let legacyURL = OpenClawClientDatabases.legacyPerGatewayDatabaseURL(
            gatewayID: composedGatewayID,
            directoryURL: directory)
        try createLegacyV2Database(
            at: legacyURL,
            gatewayID: composedGatewayID,
            commandID: "unowned")

        let databases = try OpenClawClientDatabases(
            directoryURL: directory,
            registeredGatewayIDs: [decomposedGatewayID])

        #expect(await databases.store(gatewayID: composedGatewayID).loadCommands().isEmpty)
        #expect(FileManager.default.fileExists(atPath: legacyURL.path))
    }

    @Test func `preserved shared legacy database blocks targeted forget`() async throws {
        let databaseDirectory = directory.appendingPathComponent("databases", isDirectory: true)
        let legacyDirectory = directory.appendingPathComponent("legacy", isDirectory: true)
        try FileManager.default.createDirectory(at: legacyDirectory, withIntermediateDirectories: true)
        let legacyURL = legacyDirectory.appendingPathComponent("chat-cache.sqlite")
        try withRawDatabase(at: legacyURL) { raw in
            execute(raw, "PRAGMA user_version = 99;")
        }
        let databases = try OpenClawClientDatabases(
            directoryURL: databaseDirectory,
            legacyDirectoryURLs: [legacyDirectory])
        let store = databases.store(gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "keep", text: "not forgotten")))

        #expect(throws: (any Error).self) {
            try databases.removeGatewayData(gatewayID: "gw-a")
        }

        #expect(FileManager.default.fileExists(atPath: legacyURL.path))
        #expect(await store.loadCommands().map(\.id) == ["keep"])
    }

    @Test func `legacy v6 imports attachments and routing identity`() async throws {
        let legacyURL = directory.appendingPathComponent("chat-cache.sqlite")
        let attachment = OpenClawChatOutboxAttachment(
            type: "image",
            mimeType: "image/jpeg",
            fileName: "photo.jpg",
            data: Data([1, 2, 3]),
            durationSeconds: nil)
        let attachmentsJSON = try #require(String(
            data: JSONEncoder().encode([attachment]),
            encoding: .utf8))
        try withRawDatabase(at: legacyURL) { raw in
            execute(raw, """
            CREATE TABLE outbox_commands(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_uuid TEXT NOT NULL UNIQUE,
                gateway_id TEXT NOT NULL,
                session_key TEXT NOT NULL,
                delivery_session_key TEXT NOT NULL DEFAULT '',
                routing_contract TEXT NOT NULL DEFAULT '',
                agent_id TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL,
                attachments TEXT NOT NULL DEFAULT '[]',
                attachment_bytes INTEGER NOT NULL DEFAULT 0,
                thinking TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                status TEXT NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE gateway_routing_identity(
                gateway_id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                main_session_key TEXT NOT NULL,
                default_agent_id TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
            """)
            var statement: OpaquePointer?
            #expect(sqlite3_prepare_v2(raw, """
            INSERT INTO outbox_commands(
                client_uuid, gateway_id, session_key, delivery_session_key,
                routing_contract, agent_id, text, attachments, attachment_bytes,
                thinking, created_at, status, retry_count, last_error
            ) VALUES (?, 'gw-a', 'main', 'agent:main:main',
                'per-sender|main|main', 'main', 'with image', ?, 3,
                'off', 1, 'queued', 0, '')
            """, -1, &statement, nil) == SQLITE_OK)
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            sqlite3_bind_text(statement, 1, "legacy-v6", -1, transient)
            sqlite3_bind_text(statement, 2, attachmentsJSON, -1, transient)
            #expect(sqlite3_step(statement) == SQLITE_DONE)
            sqlite3_finalize(statement)
            execute(raw, """
            INSERT INTO gateway_routing_identity(
                gateway_id, scope, main_session_key, default_agent_id, updated_at
            ) VALUES ('gw-a', 'per-sender', 'main', 'main', 10);
            PRAGMA user_version = 6;
            """)
        }

        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let command = try #require(await databases.store(gatewayID: "gw-a").loadCommands().first)

        #expect(command.id == "legacy-v6")
        #expect(command.attachments == [attachment])
        #expect(databases.loadSessionRoutingIdentity(gatewayID: "gw-a")?.contract == "per-sender|main|main")
        #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
    }

    @Test func `unknown or corrupt legacy files remain untouched`() async throws {
        let unknownURL = directory.appendingPathComponent("chat-cache.sqlite")
        try withRawDatabase(at: unknownURL) { raw in
            execute(raw, "PRAGMA user_version = 999")
        }
        _ = try OpenClawClientDatabases(directoryURL: directory)
        #expect(FileManager.default.fileExists(atPath: unknownURL.path))

        let corruptDirectory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: corruptDirectory) }
        let corruptURL = corruptDirectory.appendingPathComponent("chat-cache.sqlite")
        let bytes = Data("unknown durable format".utf8)
        try bytes.write(to: corruptURL)
        let databases = try OpenClawClientDatabases(directoryURL: corruptDirectory)
        #expect(try Data(contentsOf: corruptURL) == bytes)
        #expect(try await databases.stateQueue.read { db in try db.tableExists("outbox_commands") })
    }
}

final class ChatCommandOutboxStoreTests: ClientDatabaseTestSuite, @unchecked Sendable {
    @Test func `session settings expectation survives a cold outbox reopen`() async throws {
        let expectation = OpenClawChatSessionSettingsExpectation(
            permissionMode: .guarded,
            toolOverrides: OpenClawChatSessionToolOverrides(
                webSearch: false,
                mcpToolsDeny: ["github": ["delete_issue"]]))
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "settings-bound",
            sessionKey: "main",
            deliverySessionKey: "agent:main:main",
            routingContract: "per-sender|main|main",
            agentID: "main",
            text: "safe replay",
            thinking: "off",
            expectedSessionSettings: expectation,
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)))
        try databases.close()

        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        #expect(await reopened.store(gatewayID: "gw-a").loadCommands().first?.expectedSessionSettings == expectation)
    }

    @Test func `legacy null settings row cannot claim or retry without current client authorization`() async throws {
        try databases.close()
        let stateURL = directory.appendingPathComponent("client-state.sqlite")
        try withRawDatabase(at: stateURL) { raw in
            execute(raw, """
            INSERT INTO outbox_commands(
                gateway_id, client_uuid, session_key, delivery_session_key,
                routing_contract, agent_id, text, thinking, created_at, status
            ) VALUES (
                'gw-a', 'legacy-null-settings', 'main', 'agent:main:main',
                'per-sender|main|main', 'main', 'legacy replay', 'off', 1, 'queued'
            );
            UPDATE outbox_commands
            SET status = 'sending'
            WHERE client_uuid = 'legacy-null-settings';
            """)
        }

        let claimed = try OpenClawClientDatabases(directoryURL: directory)
        let claimedCommand = try #require(await claimed.store(gatewayID: "gw-a").loadCommands().first)
        #expect(claimedCommand.status == .failed)
        #expect(claimedCommand.lastError == OpenClawChatSQLiteTranscriptCache.outboxSettingsUpgradeRequiredError)
        #expect(claimedCommand.expectedSessionSettings == nil)
        try claimed.close()

        try withRawDatabase(at: stateURL) { raw in
            let result = sqlite3_exec(
                raw,
                """
                UPDATE outbox_commands
                SET status = 'queued'
                WHERE client_uuid = 'legacy-null-settings';
                """,
                nil,
                nil,
                nil)
            #expect(result == SQLITE_CONSTRAINT)
        }

        let retried = try OpenClawClientDatabases(directoryURL: directory)
        let retriedCommand = try #require(await retried.store(gatewayID: "gw-a").loadCommands().first)
        #expect(retriedCommand.status == .failed)
        #expect(retriedCommand.expectedSessionSettings == nil)
    }

    @Test func `pre v7 upgrade reopens and fences a settings bound retry`() async throws {
        try databases.close()
        let stateURL = directory.appendingPathComponent("client-state.sqlite")
        try withRawDatabase(at: stateURL) { raw in
            execute(raw, """
            DROP TRIGGER outbox_settings_claim_guard;
            DROP TRIGGER outbox_settings_retry_guard;
            ALTER TABLE outbox_commands DROP COLUMN settings_retry_authorization;
            ALTER TABLE outbox_commands DROP COLUMN expected_settings_json;
            DELETE FROM grdb_migrations WHERE identifier IN (
                'client-state-outbox-settings-expectation-v7',
                'client-state-outbox-settings-claim-v8'
            );
            INSERT INTO outbox_commands(
                gateway_id, client_uuid, session_key, delivery_session_key,
                routing_contract, agent_id, text, thinking, created_at, status
            ) VALUES (
                'gw-a', 'pre-v7-preserved', 'main', 'agent:main:main',
                'per-sender|main|main', 'main', 'preserve across upgrade', 'off', 1, 'queued'
            );
            """)
        }

        let upgraded = try OpenClawClientDatabases(directoryURL: directory)
        let upgradedStore = upgraded.store(gatewayID: "gw-a")
        let preserved = try #require(await upgradedStore.loadCommands().first(where: {
            $0.id == "pre-v7-preserved"
        }))
        #expect(preserved.text == "preserve across upgrade")
        #expect(preserved.expectedSessionSettings == nil)
        let expectation = OpenClawChatSessionSettingsExpectation(
            permissionMode: .readOnly,
            toolOverrides: OpenClawChatSessionToolOverrides(webSearch: false))
        #expect(await upgradedStore.enqueueCommand(OpenClawChatOutboxCommand(
            id: "legacy-writer-settings",
            sessionKey: "main",
            deliverySessionKey: "agent:main:main",
            routingContract: "per-sender|main|main",
            agentID: "main",
            text: "preserve authority",
            thinking: "off",
            expectedSessionSettings: expectation,
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)))
        try upgraded.close()

        try withRawDatabase(at: stateURL) { raw in
            execute(raw, """
            UPDATE outbox_commands
            SET status = 'sending'
            WHERE client_uuid = 'legacy-writer-settings';
            """)
        }

        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        let reopenedStore = reopened.store(gatewayID: "gw-a")
        let failed = try #require(await reopenedStore.loadCommands().first(where: {
            $0.id == "legacy-writer-settings"
        }))
        #expect(failed.status == .failed)
        #expect(failed.lastError == OpenClawChatSQLiteTranscriptCache.outboxSettingsUpgradeRequiredError)
        #expect(failed.expectedSessionSettings == expectation)
        #expect(await reopenedStore.markCommandRetriedIfPresent(
            id: failed.id,
            expectation: retryExpectation(failed),
            agentID: "main",
            deliverySessionKey: "agent:main:main",
            routingContract: "per-sender|main|main",
            expectedSessionSettings: expectation,
            replacementID: nil) == .updated)
        try reopened.close()

        let retried = try OpenClawClientDatabases(directoryURL: directory)
        let retriedCommand = try #require(await retried.store(gatewayID: "gw-a").loadCommands().first(where: {
            $0.id == "legacy-writer-settings"
        }))
        #expect(retriedCommand.status == .queued)
        #expect(retriedCommand.expectedSessionSettings == expectation)
    }

    @Test func `nil agent rows use the canonical empty scope owner`() async throws {
        let scope = OpenClawChatOutboxScope(sessionKey: "main", agentID: nil)
        #expect(await store.updateLastActiveLeafEntryID("leaf-a", expectedEpoch: 0, for: scope))
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "nil-agent", sessionKey: "main", deliverySessionKey: "main",
            routingContract: "legacy-unbound", agentID: nil, text: "deliver", thinking: "off",
            createdAt: Date().timeIntervalSince1970, status: .queued, retryCount: 0, lastError: nil)))
        let state = try #require(await store.branchState(for: scope))
        #expect(state.hadPendingCommands)
        #expect(await store.claimNextCommand()?.id == "nil-agent")
        #expect(await store.loadCommands().first?.agentID == nil)
    }

    @Test func `parked accepted rows mint retry identity while queued rows keep it`() async throws {
        let sendingScope = OpenClawChatOutboxScope(sessionKey: "sending", agentID: "main")
        #expect(await store.updateLastActiveLeafEntryID("leaf-a", expectedEpoch: 0, for: sendingScope))
        let sendingState = try #require(await store.branchState(for: sendingScope))
        #expect(await store.enqueueCommand(outboxCommand(id: "sending", sessionKey: "sending", text: "maybe accepted")))
        let sending = try #require(await store.claimNextCommand())
        _ = try #require(await store.reconcileForTest(sendingScope, previousState: sendingState))
        let parkedSending = try #require(await store.loadCommands().first(where: { $0.id == sending.id }))
        #expect(await store.markCommandRetriedIfPresent(
            id: parkedSending.id,
            expectation: retryExpectation(parkedSending),
            agentID: "main", deliverySessionKey: "sending", routingContract: "per-sender|sending|main",
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(permissionMode: nil, toolOverrides: nil),
            replacementID: "sending-retry") == .updated)
        let retriedSending = try #require(await store.loadCommands().first(where: { $0.id == "sending-retry" }))
        #expect(retriedSending.attemptVersion == 1)

        let queuedScope = OpenClawChatOutboxScope(sessionKey: "queued", agentID: "main")
        #expect(await store.updateLastActiveLeafEntryID("leaf-a", expectedEpoch: 0, for: queuedScope))
        let queuedState = try #require(await store.branchState(for: queuedScope))
        #expect(await store.enqueueCommand(outboxCommand(id: "queued", sessionKey: "queued", text: "not sent")))
        _ = try #require(await store.reconcileForTest(queuedScope, previousState: queuedState))
        let parkedQueued = try #require(await store.loadCommands().first(where: { $0.id == "queued" }))
        #expect(await store.markCommandRetriedIfPresent(
            id: parkedQueued.id,
            expectation: retryExpectation(parkedQueued),
            agentID: "main", deliverySessionKey: "queued", routingContract: "per-sender|queued|main",
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(permissionMode: nil, toolOverrides: nil),
            replacementID: "unused") == .updated)
        #expect(await store.loadCommands().contains(where: { $0.id == "queued" && $0.attemptVersion == 2 }))

        let stickyFixture = try ClientDatabaseTestSuite()
        defer { withExtendedLifetime(stickyFixture) {} }
        let requeuedScope = OpenClawChatOutboxScope(sessionKey: "requeued", agentID: "main")
        #expect(await stickyFixture.store.updateLastActiveLeafEntryID("leaf-a", expectedEpoch: 0, for: requeuedScope))
        let requeuedState = try #require(await stickyFixture.store.branchState(for: requeuedScope))
        #expect(await stickyFixture.store.enqueueCommand(outboxCommand(
            id: "requeued",
            sessionKey: "requeued",
            text: "uncertain")))
        let claimed = try #require(await stickyFixture.store.claimNextCommand())
        #expect(await stickyFixture.store.markCommandQueued(
            id: claimed.id,
            attemptVersion: claimed.attemptVersion,
            retryCount: 1,
            lastError: "transport") == .updated)
        _ = try #require(await stickyFixture.store.reconcileForTest(requeuedScope, previousState: requeuedState))
        let parkedRequeued = try #require(await stickyFixture.store.loadCommands()
            .first(where: { $0.id == "requeued" }))
        #expect(await stickyFixture.store.markCommandRetriedIfPresent(
            id: parkedRequeued.id,
            expectation: retryExpectation(parkedRequeued),
            agentID: "main", deliverySessionKey: "requeued", routingContract: "per-sender|requeued|main",
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(permissionMode: nil, toolOverrides: nil),
            replacementID: "requeued-retry") == .updated)
        #expect(await stickyFixture.store.loadCommands()
            .contains(where: { $0.id == "requeued-retry" && $0.attemptVersion == 1 }))
    }

    @Test func `parked accepted attachment follows the fresh retry identity`() async throws {
        let scope = OpenClawChatOutboxScope(sessionKey: "main", agentID: "main")
        let attachment = OpenClawChatOutboxAttachment(
            type: "audio",
            mimeType: "audio/m4a",
            fileName: "note.m4a",
            data: Data([1, 2, 3]),
            durationSeconds: 1)
        #expect(await store.updateLastActiveLeafEntryID("leaf-a", expectedEpoch: 0, for: scope))
        let state = try #require(await store.branchState(for: scope))
        #expect(await store.enqueueCommand(outboxCommand(
            id: "attached",
            text: "maybe accepted",
            attachments: [attachment])))
        _ = try #require(await store.claimNextCommand())
        _ = try #require(await store.reconcileForTest(scope, previousState: state))
        let parked = try #require(await store.loadCommands().first)

        #expect(await store.markCommandRetriedIfPresent(
            id: parked.id,
            expectation: retryExpectation(parked),
            agentID: "main",
            deliverySessionKey: "main",
            routingContract: "per-sender|main|main",
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(permissionMode: nil, toolOverrides: nil),
            replacementID: "attached-retry") == .updated)
        let retried = try #require(await store.loadCommands().first)
        #expect(retried.id == "attached-retry")
        #expect(retried.attachments == [attachment])
    }

    @Test func `empty root reconcile permits first row and parks a wiped scope`() async throws {
        let root = OpenClawChatOutboxScope(sessionKey: "root", agentID: "main")
        let rootState = try #require(await store.branchState(for: root))
        _ = try #require(await store.reconcileForTest(
            root,
            previousState: rootState,
            activeLeafEntryID: nil,
            branchLeafEntryIDs: []))
        #expect(await store.branchState(for: root)?.lastActiveLeafEntryID == nil)
        #expect(await store.enqueueCommand(outboxCommand(id: "first", sessionKey: "root", text: "first")))
        #expect(await store.claimNextCommand()?.id == "first")

        let wiped = OpenClawChatOutboxScope(sessionKey: "wiped", agentID: "main")
        #expect(await store.updateLastActiveLeafEntryID("leaf-a", expectedEpoch: 0, for: wiped))
        let wipedState = try #require(await store.branchState(for: wiped))
        #expect(await store.enqueueCommand(outboxCommand(id: "wiped", sessionKey: "wiped", text: "park")))
        _ = try #require(await store.reconcileForTest(
            wiped,
            previousState: wipedState,
            activeLeafEntryID: nil,
            branchLeafEntryIDs: []))
        #expect(await store.loadCommands().first(where: { $0.id == "wiped" })?.status == .failed)
    }

    @Test func `nonancestral parking gives failed uncertain rows a fresh retry identity`() async throws {
        let scope = OpenClawChatOutboxScope(sessionKey: "main", agentID: "main")
        #expect(await store.updateLastActiveLeafEntryID("leaf-a", expectedEpoch: 0, for: scope))
        let state = try #require(await store.branchState(for: scope))
        var failed = outboxCommand(id: "failed", text: "retry")
        failed.status = .failed
        failed.lastError = "transport"
        #expect(await store.enqueueCommand(failed))
        try await databases.stateQueue.write { db in
            try db.execute(
                sql: "UPDATE outbox_commands SET had_unacknowledged_send = 1 WHERE client_uuid = ?",
                arguments: ["failed"])
        }
        _ = try #require(await store.reconcileForTest(scope, previousState: state))
        let parked = try #require(await store.loadCommands().first)
        #expect(await store.markCommandRetriedIfPresent(
            id: parked.id,
            expectation: retryExpectation(parked),
            agentID: "main", deliverySessionKey: "main", routingContract: "per-sender|main|main",
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(permissionMode: nil, toolOverrides: nil),
            replacementID: "failed-retry") == .updated)
        #expect(await store.loadCommands().first?.id == "failed-retry")
    }

    @Test func `bulk branch parking invalidates sibling subscribers`() async throws {
        let sibling = databases.store(gatewayID: "gw-a")
        let otherGateway = databases.store(gatewayID: "gw-b")
        let scope = OpenClawChatOutboxScope(sessionKey: "main", agentID: "main")
        #expect(await store.updateLastActiveLeafEntryID("leaf-a", expectedEpoch: 0, for: scope))
        #expect(await store.enqueueCommand(outboxCommand(id: "shared", text: "park me")))
        let changes = sibling.changes()
        let otherChanges = otherGateway.changes()
        var iterator = changes.makeAsyncIterator()
        _ = try #require(await store.confirmBranchChange(
            scope, activeLeafEntryID: "leaf-b", lastError: "branch changed"))
        #expect(await iterator.next() == .invalidated(gatewayID: "gw-a", scope: scope))
        let crossGatewayDelivered = await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                var iterator = otherChanges.makeAsyncIterator()
                return await iterator.next() != nil
            }
            group.addTask {
                try? await Task.sleep(for: .milliseconds(25))
                return false
            }
            let result = await group.next() ?? true
            group.cancelAll()
            return result
        }
        #expect(crossGatewayDelivered == false)
        #expect(await sibling.loadCommands().first?.status == .failed)
    }

    @Test func `retiring a store ends only its forwarded change streams`() async throws {
        let retired = databases.store(gatewayID: "gw-a")
        let sibling = databases.store(gatewayID: "gw-a")
        var retiredIterator = retired.changes().makeAsyncIterator()
        var siblingIterator = sibling.changes().makeAsyncIterator()

        await retired.retire()
        #expect(await retiredIterator.next() == nil)

        let scope = OpenClawChatOutboxScope(sessionKey: "main", agentID: "main")
        #expect(await sibling.updateLastActiveLeafEntryID("leaf-a", expectedEpoch: 0, for: scope))
        #expect(await sibling.enqueueCommand(outboxCommand(id: "sibling", text: "park")))
        _ = try #require(await sibling.confirmBranchChange(
            scope, activeLeafEntryID: "leaf-b", lastError: "branch changed"))
        #expect(await siblingIterator.next() == .invalidated(gatewayID: "gw-a", scope: scope))
    }

    @Test func `commands and attachment blobs round trip in order`() async throws {
        let attachment = OpenClawChatOutboxAttachment(
            type: "audio",
            mimeType: "audio/m4a",
            fileName: "note.m4a",
            data: Data([4, 5, 6]),
            durationSeconds: 1.5)
        #expect(await store.enqueueCommand(outboxCommand(
            id: "later", text: "two", attachments: [attachment], createdAt: 2)))
        #expect(await store.enqueueCommand(outboxCommand(id: "earlier", text: "one", createdAt: 1)))

        let commands = await store.loadCommands()
        #expect(commands.map(\.id) == ["earlier", "later"])
        #expect(commands[1].attachments == [attachment])
        #expect(try await databases.stateQueue.read { db in
            try Data.fetchOne(db, sql: "SELECT payload FROM outbox_attachments WHERE command_id = 'later'")
        } == attachment.data)
    }

    @Test func `claims are insertion FIFO when timestamps tie and exclusive`() async throws {
        let now = Date().timeIntervalSince1970
        #expect(await store.enqueueCommand(outboxCommand(id: "z-first", text: "one", createdAt: now)))
        #expect(await store.enqueueCommand(outboxCommand(id: "a-second", text: "two", createdAt: now)))
        let first = try #require(await store.claimNextCommand())
        #expect(first.id == "z-first")
        #expect(await store.claimNextCommand() == nil)
        #expect(await store.markCommandAwaitingConfirmation(
            id: "z-first",
            attemptVersion: first.attemptVersion) == .updated)
        #expect(await store.claimNextCommand()?.id == "a-second")
    }

    @Test func `cancellation stops only unclaimed client state`() async {
        #expect(await store.enqueueCommand(outboxCommand(id: "queued", text: "delete")))
        #expect(await store.cancelCommand(id: "queued") == .updated)
        #expect(await store.loadCommands().isEmpty)

        #expect(await store.enqueueCommand(outboxCommand(id: "claimed", text: "send")))
        #expect(await store.claimNextCommand()?.id == "claimed")
        #expect(await store.cancelCommand(id: "claimed") == .missing)
        #expect(await store.loadCommands().map(\.status) == [.sending])
    }

    @Test func `canonical proof wins a cancellation race`() async {
        #expect(await store.enqueueCommand(outboxCommand(id: "landed", text: "sent")))
        store.observeCanonicalMessageIdempotencyKeys(["landed:user"])

        #expect(await store.cancelCommand(id: "landed") == .confirmed)
        #expect(await store.loadCommands().isEmpty)
    }

    @Test func `interrupted sends fail closed once`() async throws {
        #expect(await store.enqueueCommand(outboxCommand(id: "interrupted", text: "maybe sent")))
        #expect(await store.claimNextCommand()?.status == .sending)
        #expect(await store.recoverInterruptedSends())
        let recovered = try #require(await store.loadCommands().first)
        #expect(recovered.status == .failed)
        #expect(recovered.lastError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
        #expect(await store.recoverInterruptedSends())
    }

    @Test func `retired facade cannot recover a replacement facades sends`() async {
        let retired = databases.store(gatewayID: "gw-a")
        #expect(await retired.enqueueCommand(outboxCommand(id: "live", text: "sending")))
        #expect(await retired.claimNextCommand()?.status == .sending)
        await retired.retire()

        #expect(await retired.recoverInterruptedSends() == false)
        let replacement = databases.store(gatewayID: "gw-a")
        #expect(await replacement.loadCommands().map(\.status) == [.sending])
    }

    @Test func `retry adopts a fresh verified route`() async throws {
        #expect(await store.enqueueCommand(outboxCommand(id: "retry", text: "again", status: .failed)))

        let failed = try #require(await store.loadCommands().first)
        #expect(await store.markCommandRetriedIfPresent(
            id: "retry",
            expectation: retryExpectation(failed),
            agentID: "Agent-B",
            deliverySessionKey: "agent:agent-b:main",
            routingContract: "per-sender|main|agent-b",
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(permissionMode: nil, toolOverrides: nil),
            replacementID: nil) == .updated)
        let command = try #require(await store.loadCommands().first)
        #expect(command.status == .queued)
        #expect(command.agentID == "agent-b")
        #expect(command.deliverySessionKey == "agent:agent-b:main")
        #expect(command.routingContract == "per-sender|main|agent-b")
    }

    @Test func `stale queued and acknowledged commands require user action`() async throws {
        let old = Date().timeIntervalSince1970 - OpenClawChatSQLiteTranscriptCache.outboxCommandMaxAge - 1
        #expect(await store.enqueueCommand(outboxCommand(id: "old-queued", text: "old", createdAt: old)))
        #expect(await store.enqueueCommand(outboxCommand(id: "old-ack", text: "old ack")))
        let acknowledged = try #require(await store.claimNextCommand())
        #expect(acknowledged.id == "old-ack")
        #expect(await store.markCommandAwaitingConfirmation(
            id: "old-ack",
            attemptVersion: acknowledged.attemptVersion) == .updated)
        try await databases.stateQueue.write { db in
            try db.execute(
                sql: "UPDATE outbox_commands SET created_at = ? WHERE gateway_id = ? AND client_uuid = ?",
                arguments: [old, "gw-a", "old-ack"])
        }

        let commands = await store.loadCommands()
        let commandsByID = Dictionary(uniqueKeysWithValues: commands.map { ($0.id, $0) })
        #expect(commandsByID["old-queued"]?.status == .failed)
        #expect(commandsByID["old-queued"]?.lastError == OpenClawChatSQLiteTranscriptCache.outboxExpiredError)
        #expect(commandsByID["old-ack"]?.status == .failed)
        #expect(commandsByID["old-ack"]?.lastError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
    }

    @Test func `queue and attachment budgets are gateway scoped`() async {
        let storeA = databases.store(gatewayID: "gw-a")
        let storeB = databases.store(gatewayID: "gw-b")
        for index in 0..<OpenClawChatSQLiteTranscriptCache.maxQueuedCommands {
            #expect(await storeA.enqueueCommand(outboxCommand(id: "a-\(index)", text: "x")))
        }
        #expect(await storeA.enqueueCommand(outboxCommand(id: "overflow", text: "x")) == false)
        #expect(await storeB.enqueueCommand(outboxCommand(id: "b-1", text: "other gateway")))

        let oversized = OpenClawChatOutboxAttachment(
            type: "file",
            mimeType: "application/octet-stream",
            fileName: "large.bin",
            data: Data(count: OpenClawChatSQLiteTranscriptCache.maxAttachmentBytesPerCommand + 1))
        #expect(await storeB.enqueueCommand(outboxCommand(
            id: "too-large",
            text: "large",
            attachments: [oversized])) == false)
        #expect(OpenClawChatSQLiteTranscriptCache.canEnqueueAttachmentBytes(
            commandBytes: 1,
            queuedBytes: OpenClawChatSQLiteTranscriptCache.maxQueuedAttachmentBytes - 1))
        #expect(!OpenClawChatSQLiteTranscriptCache.canEnqueueAttachmentBytes(
            commandBytes: 2,
            queuedBytes: OpenClawChatSQLiteTranscriptCache.maxQueuedAttachmentBytes - 1))
    }
}

final class WatchMessageJournalStoreTests: ClientDatabaseTestSuite, @unchecked Sendable {
    private let now = Int64(Date().timeIntervalSince1970 * 1000)
    private var journal: OpenClawWatchMessageJournal {
        self.databases.watchMessages
    }

    private func context(gatewayID: String = "gw-a") async throws -> OpenClawWatchChatDeliveryContext {
        try await self.journal.importLegacy(.init(messages: [], recentMessageIDs: []), nowMs: self.now)
        let identity = try #require(OpenClawChatSessionRoutingIdentity(contract: "per-sender|main|main"))
        await databases.store(gatewayID: gatewayID).storeSessionRoutingIdentity(identity)
        let route = try #require(try await journal.route(gatewayStableID: gatewayID))
        return try OpenClawWatchChatDeliveryContext(
            gatewayStableID: gatewayID, routeGeneration: #require(route.owner.routeGeneration),
            agentId: "main", sessionKey: "main", deliverySessionKey: "agent:main:main",
            sessionRoutingContract: route.routingIdentity.contract)
    }

    private func command(id: String = "watch-command", text: String = "hello", gatewayID: String = "gw-a") async throws
        -> OpenClawWatchChatDeliveryCommand
    {
        try await OpenClawWatchChatDeliveryCommand(
            context: self.context(gatewayID: gatewayID), commandId: id, submittedAtMs: self.now,
            body: .chat(text: text))
    }

    private func claim(_ command: OpenClawWatchChatDeliveryCommand) async throws -> OpenClawWatchMessageEntry {
        _ = try await self.journal.admit(command, nowMs: self.now)
        return try #require(try await self.journal.claim(
            command, nowMs: self.now))
    }

    @Test func `Watch admission waits for a prepared legacy import`() async throws {
        await #expect(throws: OpenClawWatchChatDeliveryError.self) {
            _ = try await self.journal.route(gatewayStableID: "gw-a")
        }
        await #expect(throws: OpenClawWatchChatDeliveryError.self) {
            try await self.journal.importLegacy(.init(messages: [], recentMessageIDs: []), nowMs: Int64.max)
        }
        await #expect(throws: OpenClawWatchChatDeliveryError.self) {
            _ = try await journal.route(gatewayStableID: "gw-a")
        }
        try await self.journal.importLegacy(.init(messages: [], recentMessageIDs: []), nowMs: self.now)
        #expect(try await self.journal.route(gatewayStableID: "gw-a") == nil)
    }

    @Test func `Watch admission receipt and immutable payload survive reopen`() async throws {
        let input = try await command()
        let admitted = try await journal.admit(input, nowMs: self.now)
        let duplicate = try await journal.admit(input, nowMs: self.now + 1000)
        #expect(duplicate == admitted)
        #expect(admitted.receipt?.state == .admitted(atMs: self.now))
        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? reopened.close() }
        #expect(try await reopened.watchMessages.entries() == [admitted])
        #expect(try await reopened.watchMessages.route(gatewayStableID: "gw-a")?.owner == admitted.owner)

        let changed = OpenClawWatchChatDeliveryCommand(
            context: input.context, commandId: input.commandId, submittedAtMs: self.now, body: .chat(text: "different"))
        await #expect(throws: OpenClawWatchChatDeliveryError.self) {
            _ = try await self.journal.admit(changed, nowMs: self.now)
        }
        await #expect(throws: OpenClawWatchChatDeliveryError.self) {
            _ = try await self.journal.admit(input, nowMs: self.now, destination: .phone)
        }
        #expect(try await self.journal.entries() == [admitted])
    }

    @Test func `failed Watch insert rolls back without an admission receipt`() async throws {
        let input = try await command()
        try await databases.stateQueue.write { db in
            try db.execute(sql: """
            CREATE TRIGGER reject_watch_insert BEFORE INSERT ON watch_message_journal
            BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END;
            """)
        }
        await #expect(throws: DatabaseError.self) { _ = try await self.journal.admit(input, nowMs: self.now) }
        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? reopened.close() }
        #expect(try await reopened.watchMessages.entries().isEmpty)
    }

    @Test func `accepted Watch run resumes readback and terminal receipt replays without another claim`() async throws {
        let input = try await command()
        let claimed = try await claim(input)
        #expect(try await self.journal.recordAccepted(claimed, runID: "owned-run") == .applied)
        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? reopened.close() }
        let recovered = reopened.watchMessages
        try await recovered.recoverInterruptedWork(nowMs: self.now)
        let accepted = try #require(try await recovered.accepted(owner: .init(context: input.context)).first)
        #expect(accepted.acceptedRunID == "owned-run")
        #expect(try await recovered.claim(
            input,
            nowMs: self.now) == nil)
        #expect(try await recovered
            .recordTerminal(accepted, outcome: .reply(text: "owned reply"), nowMs: self.now) == .applied)
        let ready = try #require(try await recovered.pendingReceipts().first)
        let receipt = try #require(ready.receipt)
        #expect(receipt.terminal?.runId == "owned-run")
        #expect(try await recovered.admit(input, nowMs: self.now + 1).receipt == receipt)
        let ack = try OpenClawWatchChatDeliveryReceiptAck(
            context: input.context, commandId: input.commandId, receiptId: #require(receipt.terminal?.receiptId))
        #expect(try await recovered.acknowledge(ack) == .applied)
        #expect(try await recovered.pendingReceipts().isEmpty)
        #expect(try await recovered.admit(input, nowMs: self.now + 2).receipt == receipt)
    }

    @Test func `Watch process recovery marks an interrupted send uncertain only once`() async throws {
        let input = try await command()
        _ = try await self.claim(input)
        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? reopened.close() }
        try await reopened.watchMessages.recoverInterruptedWork(nowMs: self.now)
        let result = try #require(try await reopened.watchMessages.pendingReceipts().first)
        let outcome = try #require(result.receipt?.terminal?.outcome)
        guard case .uncertain = outcome else {
            Issue.record("An interrupted send must not become queued or successful")
            return
        }
        let another = try await command(id: "live-new-claim")
        _ = try await reopened.watchMessages.admit(another, nowMs: self.now)
        _ = try await reopened.watchMessages.claim(
            another,
            nowMs: self.now)
        try await reopened.watchMessages.recoverInterruptedWork(nowMs: self.now)
        #expect(try await reopened.watchMessages.entries().first(where: { $0.commandId == another.commandId })?
            .phase == .sending)
    }

    @Test func `not dispatched release fences a late acceptance from the previous attempt`() async throws {
        let input = try await command()
        let first = try await claim(input)
        #expect(try await self.journal.releaseNotDispatched(first) == .applied)
        let second = try #require(try await journal.claim(
            input, nowMs: self.now))
        #expect(second.attemptVersion > first.attemptVersion)
        #expect(try await self.journal.recordAccepted(first, runID: "stale-run") == .superseded)
        #expect(try await self.journal.recordAccepted(second, runID: "current-run") == .applied)
        #expect(try await self.journal.entries().first?.acceptedRunID == "current-run")
    }

    @Test func `waiting Watch chat does not block a fresh quick reply`() async throws {
        let input = try await command()
        let chat = try await claim(input)
        #expect(try await self.journal.recordAccepted(chat, runID: "chat-run") == .applied)
        let reply = OpenClawWatchChatDeliveryCommand(
            context: input.context, commandId: "quick-reply", submittedAtMs: self.now,
            body: .quickReply(promptId: "prompt", actionId: "yes", actionLabel: "Yes", note: nil))
        let quick = try await claim(reply)
        #expect(try await self.journal.recordAccepted(quick, runID: "reply-run") == .applied)
        #expect(try await self.journal.recordTerminal(quick, outcome: .forwarded, nowMs: self.now) == .applied)
        #expect(try await self.journal.pendingReceipts().map(\.commandId) == [reply.commandId])
        #expect(try await self.journal.accepted(owner: .init(context: input.context))
            .map(\.commandId) == [input.commandId])
    }

    @Test func `phone notification actions do not wait for a Watch receipt acknowledgment`() async throws {
        let input = try await command()
        _ = try await self.journal.admit(input, nowMs: self.now, destination: .phone)
        let claimed = try #require(try await journal.claim(
            input, nowMs: self.now))
        #expect(try await self.journal.recordAccepted(claimed, runID: "phone-run") == .applied)
        #expect(try await self.journal.recordTerminal(claimed, outcome: .forwarded, nowMs: self.now) == .applied)
        let entry = try #require(try await journal.entries().first)
        #expect(entry.destination == .phone)
        #expect(entry.phase == .received)
        #expect(try await self.journal.pendingReceipts().isEmpty)
    }

    @Test(arguments: ["queued", "sending", "accepted"])
    func `active Watch deliveries cannot be dismissed or discarded`(phase: String) async throws {
        let input = try await self.command()
        _ = try await self.journal.admit(input, nowMs: self.now)
        if phase != "queued" {
            let claim = try #require(try await self.journal.claim(
                input, nowMs: self.now))
            if phase == "accepted" {
                #expect(try await self.journal.recordAccepted(claim, runID: input.commandId) == .applied)
            }
        }
        let original = try #require(try await self.journal.entries().first)
        #expect(original.phase.rawValue == phase)
        #expect(try await self.journal.dismiss(id: original.commandId, exactOwner: original.owner) == .superseded)
        #expect(try await self.journal.discard(id: original.commandId, exactOwner: original.owner) == .superseded)
        #expect(try await self.journal.entries() == [original])
    }

    @Test(arguments: [false, true], [OpenClawWatchChatDeliveryKind.chat, .quickReply])
    func `dismiss preserves the committed Watch receipt and its original expiry`(
        acknowledged: Bool, kind: OpenClawWatchChatDeliveryKind) async throws
    {
        let original = try await self.command(text: "caf\u{E9}")
        let body: OpenClawWatchChatDeliveryBody = kind == .chat ? original.body :
            .quickReply(promptId: "prompt", actionId: "approve", actionLabel: nil, note: nil)
        let input = OpenClawWatchChatDeliveryCommand(
            context: original.context, commandId: original.commandId,
            submittedAtMs: original.submittedAtMs, body: body)
        let changedBody: OpenClawWatchChatDeliveryBody = kind == .chat ? .chat(text: "cafe\u{301}") :
            .quickReply(promptId: "prompt", actionId: "approve", actionLabel: nil, note: "")
        let conflicts = [
            OpenClawWatchChatDeliveryCommand(
                context: input.context, commandId: input.commandId,
                submittedAtMs: input.submittedAtMs, body: changedBody),
            OpenClawWatchChatDeliveryCommand(
                context: input.context, commandId: input.commandId,
                submittedAtMs: input.submittedAtMs + 1, body: input.body),
        ]
        let replayTime = self.now + 1000
        func requireIdentityConflict(in journal: OpenClawWatchMessageJournal) async throws {
            for command in conflicts {
                do {
                    _ = try await journal.admit(command, nowMs: replayTime)
                    Issue.record("A conflicting command must not receive another command's saved result")
                } catch let error as OpenClawWatchChatDeliveryError {
                    #expect(error.code == "identity_conflict")
                }
            }
        }
        let watch = OpenClawWatchChatDeliveryStore(
            databaseURL: self.directory.appendingPathComponent("watch-receipts.sqlite"))
        try await watch.enqueue(input, nowMs: self.now)
        let claimed = try await self.claim(input)
        #expect(try await self.journal.recordAccepted(claimed, runID: input.commandId) == .applied)
        let owner = OpenClawWatchMessageOwner(context: input.context)
        let accepted = try #require(try await self.journal.accepted(owner: owner).first)
        let outcome: OpenClawWatchChatDeliveryOutcome = kind == .chat ?
            .reply(text: "Committed terminal reply") : .forwarded
        #expect(try await self.journal.recordTerminal(accepted, outcome: outcome, nowMs: self.now) == .applied)
        let ready = try #require(try await self.journal.pendingReceipts(owner: owner).first)
        let receipt = try #require(ready.receipt)
        // The Watch commits once; its exact ACK can arrive either side of phone dismissal.
        let heldAck = try #require(try await watch.record(receipt, nowMs: self.now))
        if acknowledged {
            #expect(try await self.journal.acknowledge(heldAck) == .applied)
        }
        #expect(try await self.journal.dismiss(
            id: ready.commandId,
            exactOwner: .init(gatewayStableID: owner.gatewayStableID, routeGeneration: "different")) == .superseded)
        #expect(try await self.journal.discard(id: ready.commandId, exactOwner: owner) == .superseded)
        // Byte-distinct Unicode and nil/empty reply metadata remain different commands.
        try await requireIdentityConflict(in: self.journal)
        #expect(try await self.journal.dismiss(id: ready.commandId, exactOwner: owner) == .applied)

        let reopened = try OpenClawClientDatabases(directoryURL: self.directory)
        defer { try? reopened.close() }
        let dismissed = try #require(try await reopened.watchMessages.entries(owner: owner).first)
        #expect(dismissed.displayText == nil)
        #expect(dismissed.command == nil)
        #expect(dismissed.receipt == receipt)
        #expect(dismissed.phase == (acknowledged ? .received : .receiptReady))
        #expect(dismissed.acceptedRunID == ready.acceptedRunID)
        #expect(dismissed.attemptVersion == ready.attemptVersion)
        #expect(dismissed.expiresAtMs == input.expiresAtMs)
        let replay = try await reopened.watchMessages.admit(input, nowMs: self.now + 1000)
        #expect(replay == dismissed)
        try await requireIdentityConflict(in: reopened.watchMessages)
        let differentContext = try await OpenClawWatchChatDeliveryCommand(
            context: self.context(gatewayID: "gw-b"), commandId: input.commandId,
            submittedAtMs: input.submittedAtMs, body: input.body)
        do {
            _ = try await reopened.watchMessages.admit(differentContext, nowMs: self.now + 1000)
            Issue.record("Dismissed IDs must not admit another delivery context")
        } catch let error as OpenClawWatchChatDeliveryError {
            #expect(error.code == "identity_conflict")
        }
        #expect(try await reopened.watchMessages.claim(
            input, nowMs: self.now + 1000) == nil)
        let pending = try await reopened.watchMessages.pendingReceipts(owner: owner)
        #expect(pending.map(\.receipt) == (acknowledged ? [] : [receipt]))
        #expect(try await watch.record(receipt, nowMs: self.now + 1000) == heldAck)
        #expect(try await reopened.watchMessages.acknowledge(heldAck) == .applied)
        #expect(try await reopened.watchMessages.pendingReceipts(owner: owner).isEmpty)
        #expect(try await reopened.watchMessages.pruneExpired(nowMs: input.expiresAtMs - 1) == 0)
        #expect(try await reopened.watchMessages.pruneExpired(nowMs: input.expiresAtMs) == 1)
        #expect(try await reopened.watchMessages.entries().isEmpty)
    }

    @Test func `Forget retires the persisted Watch generation while canceled staging preserves it`() async throws {
        let input = try await command()
        let original = try await claim(input)
        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        await #expect(throws: OpenClawWatchChatDeliveryError.self) {
            _ = try await self.journal.admit(input, nowMs: self.now)
        }
        try databases.cancelGatewayRemoval(gatewayID: "gw-a")
        #expect(try await self.journal.route(gatewayStableID: "gw-a")?.owner == original.owner)
        try databases.removeGatewayData(gatewayID: "gw-a")
        #expect(try await self.journal.entries().isEmpty)
        let repaired = try await context()
        #expect(repaired.routeGeneration != input.context.routeGeneration)
        await #expect(throws: OpenClawWatchChatDeliveryError.self) {
            _ = try await self.journal.admit(input, nowMs: self.now)
        }
        #expect(try await self.journal.recordAccepted(original, runID: "late-run") == .missing)
    }

    @Test(arguments: ["accepted", "notDispatched", "uncertain"])
    func `cancelable Forget preserves late settlement without granting a new dispatch`(settlement: String) async throws {
        let input = try await self.command()
        try await self.journal.recoverInterruptedWork(nowMs: self.now)
        let original = try await self.claim(input)
        let queued = try await self.command(id: "not-yet-dispatched")
        _ = try await self.journal.admit(queued, nowMs: self.now)
        let owner = try #require(original.owner)
        try self.databases.stageGatewayRemoval(gatewayID: "gw-a")
        await #expect(throws: OpenClawWatchChatDeliveryError.self) {
            _ = try await self.journal.claim(queued, nowMs: self.now)
        }

        let expectedPhase: OpenClawWatchMessagePhase
        switch settlement {
        case "accepted":
            #expect(try await self.journal.recordAccepted(original, runID: input.commandId) == .applied)
            expectedPhase = .accepted
        case "notDispatched":
            #expect(try await self.journal.releaseNotDispatched(original) == .applied)
            expectedPhase = .queued
        default:
            #expect(try await self.journal.recordTerminal(
                original, outcome: .uncertain(message: "Connection ended"), nowMs: self.now) == .applied)
            expectedPhase = .receiptReady
        }
        try self.databases.cancelGatewayRemoval(gatewayID: "gw-a")
        try await self.journal.recoverInterruptedWork(nowMs: self.now)
        let settled = try #require(try await self.journal.entries(owner: owner)
            .first { $0.commandId == input.commandId })
        #expect(settled.phase == expectedPhase)
        #expect(settled.attemptVersion == original.attemptVersion)
        if settlement == "accepted" {
            #expect(settled.acceptedRunID == input.commandId)
        } else if settlement == "uncertain" {
            #expect(settled.receipt?.terminal?.outcome == .uncertain(message: "Connection ended"))
        }

        try self.databases.removeGatewayData(gatewayID: "gw-a")
        let replacement = try await self.claim(self.command())
        #expect(replacement.owner != original.owner)
        #expect(try await self.journal.recordAccepted(original, runID: "retired-run") == .superseded)
        #expect(try await self.journal.entries().first == replacement)
    }

    @Test(arguments: ["accepted", "notDispatched", "uncertain", "routingChanged"], ["retry", "expiry", "forget"])
    func `failed Sending settlements preserve their claim across recovery`(
        settlement: String, disposition: String) async throws
    {
        let input = try await self.command()
        // Complete initial recovery before claiming, as the coordinator does.
        try await self.journal.recoverInterruptedWork(nowMs: self.now)
        let original = try await self.claim(input)
        let owner = try #require(original.owner)
        if disposition == "retry" {
            try self.databases.stageGatewayRemoval(gatewayID: "gw-a")
        }
        defer {
            if disposition == "retry" {
                try? self.databases.cancelGatewayRemoval(gatewayID: "gw-a")
            }
        }
        try await self.databases.stateQueue.write { db in
            try db.execute(sql: """
            CREATE TRIGGER reject_watch_settlement BEFORE UPDATE OF phase ON watch_message_journal
            WHEN OLD.command_id = 'watch-command' AND OLD.phase = 'sending' AND NEW.phase != 'sending'
            BEGIN SELECT RAISE(ABORT, 'fixture settlement write failure'); END;
            """)
        }
        await #expect(throws: DatabaseError.self) {
            switch settlement {
            case "accepted":
                _ = try await self.journal.recordAccepted(original, runID: input.commandId)
            case "notDispatched":
                _ = try await self.journal.releaseNotDispatched(original)
            case "uncertain":
                _ = try await self.journal.recordTerminal(
                    original, outcome: .uncertain(message: "Connection ended"), nowMs: self.now)
            default:
                _ = try await self.journal.recordTerminal(
                    original,
                    outcome: .failed(code: "routing_changed", message: "Route changed before dispatch"),
                    nowMs: self.now)
            }
        }
        #expect(try await self.journal.entries(owner: owner) == [original])
        if disposition == "retry" {
            await #expect(throws: DatabaseError.self) {
                try await self.journal.recoverInterruptedWork(nowMs: self.now)
            }
            #expect(try await self.journal.entries(owner: owner) == [original])
        }
        try await self.databases.stateQueue.write { db in
            try db.execute(sql: "DROP TRIGGER reject_watch_settlement")
        }

        switch disposition {
        case "retry":
            // Phase one pauses dispatch, not settlement of the existing claim.
            try await self.journal.recoverInterruptedWork(nowMs: self.now)
            let settled = try #require(try await self.journal.entries(owner: owner).first)
            let expectedPhase: OpenClawWatchMessagePhase = switch settlement {
            case "accepted": .accepted
            case "notDispatched": .queued
            default: .receiptReady
            }
            #expect(settled.phase == expectedPhase)
            #expect(settled.command == input)
            #expect(settled.owner == owner)
            #expect(settled.attemptVersion == original.attemptVersion)
            #expect(settled.expiresAtMs == input.expiresAtMs)
            switch settlement {
            case "accepted":
                #expect(settled.acceptedRunID == input.commandId)
            case "notDispatched":
                #expect(settled.acceptedRunID == nil)
                #expect(settled.receipt == original.receipt)
            case "uncertain":
                guard case .uncertain? = settled.receipt?.terminal?.outcome else {
                    Issue.record("Failed uncertain settlement must remain uncertain")
                    return
                }
            default:
                guard case let .failed(code, _)? = settled.receipt?.terminal?.outcome else {
                    Issue.record("The pre-dispatch routing failure must remain a failure")
                    return
                }
                #expect(code == "routing_changed")
            }
        case "expiry":
            // Test expiry before pruning so deletion alone cannot satisfy the fence.
            try await self.journal.recoverInterruptedWork(nowMs: input.expiresAtMs)
            #expect(try await self.journal.entries(owner: owner) == [original])
            #expect(try await self.journal.pruneExpired(nowMs: input.expiresAtMs) == 1)
            let next = OpenClawWatchChatDeliveryCommand(
                context: input.context, commandId: input.commandId, submittedAtMs: input.expiresAtMs,
                body: .chat(text: "replacement after expiry"))
            _ = try await self.journal.admit(next, nowMs: input.expiresAtMs)
            let replacement = try #require(try await self.journal.claim(
                next, nowMs: input.expiresAtMs))
            try await self.journal.recoverInterruptedWork(nowMs: input.expiresAtMs)
            #expect(try await self.journal.entries(owner: owner) == [replacement])
        default:
            try self.databases.removeGatewayData(gatewayID: "gw-a")
            #expect(try await self.journal.entries().isEmpty)
            let replacement = try await self.claim(self.command(text: "replacement after Forget"))
            #expect(replacement.owner != owner)
            try await self.journal.recoverInterruptedWork(nowMs: self.now)
            #expect(try await self.journal.entries() == [replacement])
        }
    }

    @Test func `legacy import marker survives discard Forget and delayed defaults cleanup`() async throws {
        let snapshot = OpenClawWatchMessageLegacyImport(messages: [
            .init(id: "legacy-a", gatewayStableID: "gw-a", text: "keep until discard", submittedAtMs: 1),
            .init(id: "legacy-b", gatewayStableID: "gw-b", text: "keep other gateway", submittedAtMs: nil),
            .init(id: "legacy-retired", gatewayStableID: "gw-a", text: "already retired text", submittedAtMs: 1),
        ], recentMessageIDs: ["legacy-recent", "legacy-retired"])
        try await journal.importLegacy(snapshot, nowMs: self.now)
        let imported = try await journal.entries()
        #expect(imported.filter { $0.phase == .needsReview }.count == 2)
        #expect(imported.first { $0.commandId == "legacy-a" }?.expiresAtMs == nil)
        #expect(imported.first { $0.commandId == "legacy-retired" }?.displayText == nil)
        #expect(try await self.journal
            .pruneExpired(nowMs: self.now + 2 * OpenClawWatchChatDeliveryCodec.lifetimeMs) == 2)
        #expect(try await self.journal.discard(
            id: "legacy-a", exactOwner: .init(gatewayStableID: "gw-a", routeGeneration: nil)) == .applied)
        try databases.removeGatewayData(gatewayID: "gw-b")
        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        defer { try? reopened.close() }
        try await reopened.watchMessages.importLegacy(
            snapshot,
            nowMs: self.now + 3 * OpenClawWatchChatDeliveryCodec.lifetimeMs)
        #expect(try await reopened.watchMessages.entries().isEmpty)
        try await reopened.watchMessages.importLegacy(
            .init(messages: [snapshot.messages[2]], recentMessageIDs: []),
            nowMs: self.now + 4 * OpenClawWatchChatDeliveryCodec.lifetimeMs)
        #expect(try await reopened.watchMessages.entries().isEmpty)

        let later = OpenClawWatchMessageLegacyImport(messages: [
            .init(id: "later-old-writer", gatewayStableID: "gw-a", text: "new unsent text", submittedAtMs: nil),
        ], recentMessageIDs: [])
        let laterTime = self.now + 5 * OpenClawWatchChatDeliveryCodec.lifetimeMs
        try await reopened.watchMessages.importLegacy(later, nowMs: laterTime)
        let recovered = try #require(try await reopened.watchMessages.entries().first)
        #expect(recovered.commandId == "later-old-writer")
        #expect(recovered.displayText == "new unsent text")
        #expect(recovered.phase == .needsReview)
        #expect(recovered.command == nil)
        #expect(recovered.expiresAtMs == nil)
        try await reopened.watchMessages.importLegacy(later, nowMs: laterTime + 1000)
        #expect(try await reopened.watchMessages.entries() == [recovered])
    }

    @Test(arguments: ["text", "gateway", "timestamp", "unicode"])
    func `legacy recent metadata cannot erase an imported content fingerprint`(changedField: String) async throws {
        let original = OpenClawWatchMessageLegacyImport.Message(
            id: "fingerprinted", gatewayStableID: "gw-a", text: "\u{E9}", submittedAtMs: nil)
        try await self.journal.importLegacy(.init(messages: [original], recentMessageIDs: []), nowMs: self.now)
        let imported = try #require(try await self.journal.entries().first)
        #expect(try await self.journal.discard(id: imported.commandId, exactOwner: imported.owner) == .applied)
        try await self.journal.importLegacy(.init(messages: [], recentMessageIDs: [original.id]), nowMs: self.now)

        let changed = OpenClawWatchMessageLegacyImport.Message(
            id: original.id,
            gatewayStableID: changedField == "gateway" ? "gw-b" : original.gatewayStableID,
            text: changedField == "text" ? "different" : changedField == "unicode" ? "e\u{301}" : original.text,
            submittedAtMs: changedField == "timestamp" ? 0 : original.submittedAtMs)
        let fresh = OpenClawWatchMessageLegacyImport.Message(
            id: "batch-new", gatewayStableID: "gw-a", text: "keep after retry", submittedAtMs: nil)
        await #expect(throws: (any Error).self) {
            try await self.journal.importLegacy(
                .init(messages: [fresh, changed], recentMessageIDs: []), nowMs: self.now)
        }
        #expect(try await self.journal.entries().allSatisfy { $0.displayText == nil })
        try await self.journal.importLegacy(
            .init(messages: [fresh, original], recentMessageIDs: []), nowMs: self.now)
        let recovered = try await self.journal.entries().filter { $0.displayText != nil }
        #expect(recovered.map(\.commandId) == [fresh.id])
        #expect(recovered.first?.displayText == fresh.text)
    }

    @Test(arguments: [false, true])
    func `conflicting legacy batches preserve owned rows and roll back new receipts`(
        hasModernCommand: Bool) async throws
    {
        let original = OpenClawWatchMessageLegacyImport.Message(
            id: "conflicting", gatewayStableID: "gw-a", text: "original", submittedAtMs: 1)
        if hasModernCommand {
            let command = try await self.command(id: original.id, text: "modern command")
            _ = try await self.journal.admit(command, nowMs: self.now)
        }
        let before = try await self.journal.entries()
        let fresh = OpenClawWatchMessageLegacyImport.Message(
            id: "batch-new", gatewayStableID: "gw-a", text: "new text", submittedAtMs: nil)
        let changed = OpenClawWatchMessageLegacyImport.Message(
            id: original.id, gatewayStableID: original.gatewayStableID, text: "changed", submittedAtMs: 1)
        await #expect(throws: (any Error).self) {
            try await self.journal.importLegacy(
                .init(messages: [fresh, original, changed], recentMessageIDs: []), nowMs: self.now)
        }
        #expect(try await self.journal.entries() == before)
        if hasModernCommand {
            #expect(try await self.journal.route(gatewayStableID: "gw-a") != nil)
        } else {
            await #expect(throws: OpenClawWatchChatDeliveryError.self) {
                _ = try await self.journal.route(gatewayStableID: "gw-a")
            }
        }
        try await self.journal.importLegacy(.init(messages: [fresh], recentMessageIDs: []), nowMs: self.now)
        let after = try await self.journal.entries()
        #expect(after.first { $0.commandId == fresh.id }?.displayText == fresh.text)
        #expect(after.filter { $0.commandId != fresh.id } == before)
    }

    @Test(arguments: [false, true])
    func `unseen legacy IDs from a forgotten Gateway remain unimported after re-pair`(repaired: Bool) async throws {
        try await self.journal.importLegacy(.init(messages: [], recentMessageIDs: []), nowMs: self.now)
        try self.databases.removeGatewayData(gatewayID: "gw-forgotten")
        if repaired {
            _ = try await self.context(gatewayID: "gw-forgotten")
        }
        let fresh = OpenClawWatchMessageLegacyImport.Message(
            id: "other-gateway", gatewayStableID: "gw-a", text: "independent text", submittedAtMs: nil)
        let ambiguous = OpenClawWatchMessageLegacyImport.Message(
            id: "unseen-before-forget", gatewayStableID: "gw-forgotten", text: "preserve source", submittedAtMs: nil)
        await #expect(throws: (any Error).self) {
            try await self.journal.importLegacy(
                .init(messages: [fresh, ambiguous], recentMessageIDs: []), nowMs: self.now)
        }
        #expect(try await self.journal.entries().isEmpty)
        try await self.journal.importLegacy(.init(messages: [fresh], recentMessageIDs: []), nowMs: self.now)
        let recovered = try #require(try await self.journal.entries().first)
        #expect(recovered.commandId == fresh.id)
        #expect(recovered.displayText == fresh.text)
        #expect(recovered.phase == .needsReview)
    }

    @Test func `legacy import identities preserve exact UTF8 bytes`() async throws {
        let first = OpenClawWatchMessageLegacyImport.Message(
            id: "legacy-\u{E9}", gatewayStableID: "gw-a", text: "first", submittedAtMs: nil)
        let second = OpenClawWatchMessageLegacyImport.Message(
            id: "legacy-e\u{301}", gatewayStableID: "gw-a", text: "second", submittedAtMs: nil)
        try await self.journal.importLegacy(.init(messages: [first], recentMessageIDs: []), nowMs: self.now)
        try await self.journal.importLegacy(.init(messages: [second], recentMessageIDs: []), nowMs: self.now)
        let entries = try await self.journal.entries()
        #expect(entries.count == 2)
        #expect(Set(entries.map(\.id)).count == entries.count)
        #expect(Set(entries.map(\.id)) == [Data(first.id.utf8), Data(second.id.utf8)])
        #expect(entries.first { $0.id == Data(first.id.utf8) }?.displayText == first.text)
        #expect(entries.first { $0.id == Data(second.id.utf8) }?.displayText == second.text)
    }

    @Test func `failed legacy import commits neither partial rows nor its marker`() async throws {
        let snapshot = OpenClawWatchMessageLegacyImport(messages: [
            .init(id: "first", gatewayStableID: "gw-a", text: "first text", submittedAtMs: nil),
            .init(id: "reject", gatewayStableID: "gw-a", text: "second text", submittedAtMs: nil),
        ], recentMessageIDs: [])
        try await databases.stateQueue.write { db in
            try db.execute(sql: """
            CREATE TRIGGER reject_watch_import BEFORE INSERT ON watch_message_journal
            WHEN NEW.command_id = 'reject' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;
            """)
        }
        await #expect(throws: DatabaseError.self) { try await self.journal.importLegacy(snapshot, nowMs: self.now) }
        await #expect(throws: OpenClawWatchChatDeliveryError.self) {
            _ = try await self.journal.route(gatewayStableID: "gw-a")
        }
        #expect(try await self.journal.entries().isEmpty)
        try await databases.stateQueue.write { db in try db.execute(sql: "DROP TRIGGER reject_watch_import") }
        try await self.journal.importLegacy(snapshot, nowMs: self.now)
        #expect(try await self.journal.entries().count == 2)
    }

    @Test func `Watch expiry never renews a replayed command`() async throws {
        let input = try await command()
        _ = try await self.journal.admit(input, nowMs: self.now)
        #expect(try await self.journal.pruneExpired(nowMs: input.expiresAtMs) == 1)
        await #expect(throws: OpenClawWatchChatDeliveryError.self) {
            _ = try await self.journal.admit(input, nowMs: input.expiresAtMs)
        }
        let future = OpenClawWatchChatDeliveryCommand(
            context: input.context, commandId: "future",
            submittedAtMs: self.now + OpenClawWatchChatDeliveryCodec.maxFutureSkewMs + 1,
            body: .chat(text: "future"))
        await #expect(throws: OpenClawWatchChatDeliveryError.self) { _ = try await self.journal.admit(
            future,
            nowMs: self.now) }
        #expect(try await self.journal.entries().isEmpty)
    }

    @Test(.timeLimit(
        .minutes(
            1))) func `Watch list observation includes committed admissions and trigger based Forget`() async throws
    {
        let input = try await command()
        let observation = try await self.journal.changes()
        var changes = observation.makeAsyncIterator()
        #expect(try await changes.next() == [])
        _ = try await self.journal.admit(input, nowMs: self.now)
        #expect(try await changes.next()?.map(\.commandId) == [input.commandId])
        try databases.removeGatewayData(gatewayID: "gw-a")
        #expect(try await changes.next() == [])
    }

    @Test func `Watch pending capacity rejects before admission and accepted work frees a slot`() async throws {
        let target = try await context()
        for index in 0..<OpenClawWatchChatDeliveryCodec.maxPendingCommands {
            _ = try await self.journal.admit(
                .init(
                    context: target, commandId: "queued-\(index)", submittedAtMs: self.now, body: .chat(
                        text: "queued")),
                nowMs: self.now)
        }
        let extra = OpenClawWatchChatDeliveryCommand(
            context: target, commandId: "overflow", submittedAtMs: now, body: .chat(text: "overflow"))
        await #expect(throws: OpenClawWatchChatDeliveryError.self) { _ = try await self.journal.admit(
            extra,
            nowMs: self.now) }
        #expect(try await self.journal.entries().count == OpenClawWatchChatDeliveryCodec.maxPendingCommands)
        let first = try #require(try await journal.entries().first?.command)
        let claimed = try #require(try await journal.claim(
            first,
            nowMs: self.now))
        #expect(try await self.journal.recordAccepted(claimed, runID: "accepted") == .applied)
        #expect(try await self.journal.admit(extra, nowMs: self.now).commandId == "overflow")
    }

    @Test func `changed routing settles a queued Watch command without dispatch`() async throws {
        let input = try await command()
        _ = try await self.journal.admit(input, nowMs: self.now)
        try await store
            .storeSessionRoutingIdentity(#require(OpenClawChatSessionRoutingIdentity(contract: "global|main|other")))
        #expect(try await self.journal.claim(
            input,
            nowMs: self.now) == nil)
        let receipt = try #require(try await journal.pendingReceipts().first?.receipt)
        let outcome = try #require(receipt.terminal?.outcome)
        guard case let .failed(code, _) = outcome else {
            Issue.record("A changed routing contract must settle visibly")
            return
        }
        #expect(code == "routing_changed")
        #expect(try await self.journal.admit(input, nowMs: self.now + 1).receipt == receipt)
    }

    @Test func `pending Forget does not block interrupted retirement on another Gateway`() async throws {
        let first = try await self.command(id: "interrupted-a", gatewayID: "gw-a")
        let second = try await self.command(id: "interrupted-b", gatewayID: "gw-b")
        _ = try await self.claim(first)
        _ = try await self.claim(second)
        try self.databases.stageGatewayRemoval(gatewayID: "gw-a")
        let reopened = try OpenClawClientDatabases(directoryURL: self.directory)
        defer { try? reopened.close() }
        try await reopened.watchMessages.recoverInterruptedWork(nowMs: self.now)
        let recovered = try await reopened.watchMessages.pendingReceipts()
        #expect(Set(recovered.map(\.commandId)) == [first.commandId, second.commandId])
        for entry in recovered {
            let outcome = try #require(entry.receipt?.terminal?.outcome)
            guard case .uncertain = outcome else {
                Issue.record("Interrupted retirement must not assert execution or discard user text")
                return
            }
            #expect(entry.displayText != nil)
        }
        try self.databases.cancelGatewayRemoval(gatewayID: "gw-a")
        try await reopened.watchMessages.recoverInterruptedWork(nowMs: self.now)
        #expect(try await reopened.watchMessages.claim(
            first, nowMs: self.now) == nil)
    }

    @Test(arguments: [
        false,
        true,
    ]) func `first Watch journal use prunes expired fresh copies`(subscription: Bool) async throws {
        let target = try await self.context()
        let past = self.now - OpenClawWatchChatDeliveryCodec.lifetimeMs - 1000
        let input = OpenClawWatchChatDeliveryCommand(
            context: target, commandId: "expired-before-open", submittedAtMs: past,
            body: .chat(text: "expired fixture"))
        _ = try await self.journal.admit(input, nowMs: past)
        let entries: [OpenClawWatchMessageEntry]
        if subscription {
            let observation = try await self.journal.changes()
            var changes = observation.makeAsyncIterator()
            entries = try #require(try await changes.next())
        } else {
            entries = try await self.journal.entries()
        }
        #expect(entries.isEmpty)
        let remaining = try await self.databases.stateQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM watch_message_journal")
        }
        #expect(remaining == 0)
    }

    @Test func `actual v8 migrations reopen the additive Watch schema and preserve its generation`() async throws {
        let input = try await command()
        _ = try await self.journal.admit(input, nowMs: self.now)
        let older = try DatabaseQueue(path: directory
            .appendingPathComponent(OpenClawClientDatabases.clientStateFilename).path)
        defer { try? older.close() }
        var migrator = DatabaseMigrator()
        OpenClawClientDatabases.registerClientStateMigrationsV1ThroughV5(&migrator)
        OpenClawClientDatabases.registerClientStateMigrationsV6ThroughV8(&migrator)
        try migrator.migrate(older)
        // The unchanged routing writer names its fields, so an older refresh
        // preserves the generation that only the new Watch flow understands.
        try await store
            .storeSessionRoutingIdentity(#require(OpenClawChatSessionRoutingIdentity(contract: "per-sender|main|main")))
        let generation = try await older.read { db in
            try String.fetchOne(
                db,
                sql: "SELECT watch_route_generation FROM gateway_routing_identity WHERE gateway_id = 'gw-a'")
        }
        #expect(generation == input.context.routeGeneration)
        try databases.removeGatewayData(gatewayID: "gw-a")
        let remaining = try await older.read { db in try Int.fetchOne(
            db,
            sql: "SELECT COUNT(*) FROM watch_message_journal") }
        #expect(remaining == 0)
    }
}

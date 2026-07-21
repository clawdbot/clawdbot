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

private func cacheMessage(
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

private func cacheSessionEntry(key: String, updatedAt: Double) -> OpenClawChatSessionEntry {
    OpenClawChatSessionEntry(
        key: key,
        kind: nil,
        displayName: nil,
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
        await self.storeCanonicalTranscript(
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

struct ChatTranscriptCacheStoreTests {
    @Test func `one installation owns exactly the two named databases`() throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        _ = try OpenClawClientDatabases(directoryURL: directory)

        let sqliteFiles = try FileManager.default.contentsOfDirectory(atPath: directory.path)
            .filter { $0.hasSuffix(".sqlite") }
            .sorted()
        #expect(sqliteFiles == ["client-state.sqlite", "gateway-cache.sqlite"])
    }

    @Test func `full removal deletes both databases legacy files and sidecars`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let store = databases.store(gatewayID: "gw-a")
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

    @Test func `cache format mismatch rebuilds without touching client state`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let stateIdentity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "per-sender",
            mainSessionKey: "main",
            defaultAgentID: "main"))
        do {
            let databases = try OpenClawClientDatabases(directoryURL: directory)
            let store = databases.store(gatewayID: "gw-a")
            await store.storeSessionRoutingIdentity(stateIdentity)
        }
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

    @Test func `transcripts are scoped by gateway and agent in one cache`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
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

    @Test func `cache bounds sessions messages and transcript partitions`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-a")

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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let store = databases.store(gatewayID: "gw-a")
        await store.storeTestTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "old", timestamp: 1)])
        await store.storeTestTranscript(sessionKey: "main", messages: [])

        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
        #expect(try await databases.cacheQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM cached_transcripts")
        } == 0)
    }

    @Test func `canonical cache excludes optimistic outbox rows`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let store = databases.store(gatewayID: "gw-a")
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

    @Test func `canceled optimistic row cannot reenter cache from a stale snapshot`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-a")
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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let store = databases.store(gatewayID: "gw-a")
        await store.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])
        await store.storeTestTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "assistant", text: "cached", timestamp: 1)])
        try await databases.cacheQueue.write { db in
            try db.execute(
                sql: "UPDATE cached_sessions SET payload_json = 'not-json' WHERE gateway_id = 'gw-a'")
            try db.execute(
                sql: "UPDATE cached_messages SET payload_json = 'not-json' WHERE gateway_id = 'gw-a'")
        }

        #expect(await store.loadSessions().isEmpty)
        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
        #expect(try await databases.cacheQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM cached_sessions WHERE gateway_id = 'gw-a'")
        } == 0)
        #expect(try await databases.cacheQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM cached_transcripts WHERE gateway_id = 'gw-a'")
        } == 0)
    }

    @Test func `canonical merge preserves newer cache rows`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-a")
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

    @Test func `concurrent canonical merges do not lose messages`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-a")

        await withTaskGroup(of: Void.self) { group in
            for index in 0..<20 {
                group.addTask {
                    let key = "merge-\(index)"
                    await store.mergeCanonicalTranscriptMessage(
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
            details: AnyCodable(["diff": AnyCodable(oversizedDiff), "ignored": AnyCodable("drop")]))

        let cached = try #require(OpenClawChatSQLiteTranscriptCache.cacheableMessages([message]).first)
        #expect(cached.content[0].content == nil)
        #expect(cached.content[0].thinkingSignature == nil)
        #expect(Set(cached.content[0].arguments?.dictionaryValue?.keys.map(\.self) ?? []) == ["input"])
        #expect(cached.content[0].arguments?.dictionaryValue?["input"]?.stringValue?.utf16.count == 64000)
        #expect(Set(cached.details?.dictionaryValue?.keys.map(\.self) ?? []) == ["diff"])
    }

    @Test func `gateway removal deletes only that gateways cache and state`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            let databases = try OpenClawClientDatabases(directoryURL: directory)
            let store = databases.store(gatewayID: "gw-a")
            await store.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])
            #expect(await store.enqueueCommand(outboxCommand(id: "keep", text: "pending")))
            try databases.stageGatewayRemoval(gatewayID: "gw-a")
            #expect(await store.loadSessions().map(\.key) == ["main"])
            #expect(await store.loadCommands().map(\.id) == ["keep"])
            try databases.close()
        }

        do {
            let registered = try OpenClawClientDatabases(
                directoryURL: directory,
                registeredGatewayIDs: ["gw-a"])
            #expect(await registered.store(gatewayID: "gw-a").loadCommands().map(\.id) == ["keep"])
            try registered.stageGatewayRemoval(gatewayID: "gw-a")
            try registered.close()
        }

        let forgotten = try OpenClawClientDatabases(
            directoryURL: directory,
            registeredGatewayIDs: [])
        #expect(await forgotten.store(gatewayID: "gw-a").loadSessions().isEmpty)
        #expect(await forgotten.store(gatewayID: "gw-a").loadCommands().isEmpty)
        #expect(try await forgotten.stateQueue.read { db in
            try String.fetchOne(
                db,
                sql: "SELECT gateway_hash FROM forgotten_gateways WHERE gateway_id IS NULL")
        } == OpenClawClientDatabases.gatewayIdentityHash("gw-a"))
    }

    @Test func `staged gateway removal uses exact registry identifier bytes`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let composedGatewayID = "gateway-\u{00E9}"
        let decomposedGatewayID = "gateway-e\u{0301}"
        #expect(composedGatewayID == decomposedGatewayID)
        do {
            let databases = try OpenClawClientDatabases(directoryURL: directory)
            let store = databases.store(gatewayID: composedGatewayID)
            #expect(await store.enqueueCommand(outboxCommand(id: "remove", text: "pending")))
            try databases.stageGatewayRemoval(gatewayID: composedGatewayID)
            try databases.close()
        }

        let recovered = try OpenClawClientDatabases(
            directoryURL: directory,
            registeredGatewayIDs: [decomposedGatewayID])

        #expect(await recovered.store(gatewayID: composedGatewayID).loadCommands().isEmpty)
        #expect(try await recovered.stateQueue.read { db in
            try String.fetchOne(
                db,
                sql: "SELECT gateway_hash FROM forgotten_gateways WHERE gateway_id IS NULL")
        } == OpenClawClientDatabases.gatewayIdentityHash(composedGatewayID))
    }

    @Test func `commit started recovery finishes even while gateway remains registered`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            let databases = try OpenClawClientDatabases(directoryURL: directory)
            let store = databases.store(gatewayID: "gw-a")
            await store.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])
            #expect(await store.enqueueCommand(outboxCommand(id: "remove", text: "pending")))
            try databases.stageGatewayRemoval(gatewayID: "gw-a")
            // Simulate termination immediately after the irreversible state
            // transaction but before cache cleanup and tombstone finalization.
            try await databases.stateQueue.write { db in
                try db.execute(
                    sql: "UPDATE forgotten_gateways SET cleanup_phase = 2 WHERE gateway_id = ?",
                    arguments: ["gw-a"])
                try db.execute(
                    sql: "DELETE FROM outbox_commands WHERE gateway_id = ?",
                    arguments: ["gw-a"])
            }
            try databases.close()
        }

        let recovered = try OpenClawClientDatabases(
            directoryURL: directory,
            registeredGatewayIDs: ["gw-a"])
        #expect(await recovered.store(gatewayID: "gw-a").loadSessions().isEmpty)
        #expect(await recovered.store(gatewayID: "gw-a").loadCommands().isEmpty)
        #expect(try await recovered.stateQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT cleanup_phase FROM forgotten_gateways WHERE gateway_hash = ?",
                arguments: [OpenClawClientDatabases.gatewayIdentityHash("gw-a")])
        } == 0)
    }

    @Test func `hash only scrub marker remains recoverable`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            let databases = try OpenClawClientDatabases(directoryURL: directory)
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
        }

        let recovered = try OpenClawClientDatabases(directoryURL: directory)
        #expect(try await recovered.stateQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT cleanup_phase FROM forgotten_gateways WHERE gateway_hash = ?",
                arguments: [OpenClawClientDatabases.gatewayIdentityHash("gw-a")])
        } == 0)
    }

    @Test func `unknown registry preserves a cancelable staged removal`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            let databases = try OpenClawClientDatabases(directoryURL: directory)
            let store = databases.store(gatewayID: "gw-a")
            #expect(await store.enqueueCommand(outboxCommand(id: "keep", text: "pending")))
            try databases.stageGatewayRemoval(gatewayID: "gw-a")
            try databases.close()
        }

        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        #expect(await reopened.store(gatewayID: "gw-a").loadCommands().map(\.id) == ["keep"])
        #expect(try await reopened.stateQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT cleanup_phase FROM forgotten_gateways WHERE gateway_hash = ?",
                arguments: [OpenClawClientDatabases.gatewayIdentityHash("gw-a")])
        } == 1)
    }

    @Test func `pending removal marker gates writable facade recreation`() throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)

        #expect(!databases.hasPendingGatewayRemoval(gatewayID: "gw-a"))
        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        #expect(databases.hasPendingGatewayRemoval(gatewayID: "gw-a"))
        try databases.cancelGatewayRemoval(gatewayID: "gw-a")
        #expect(!databases.hasPendingGatewayRemoval(gatewayID: "gw-a"))
    }

    @Test func `cancelable stage does not suppress legacy state import`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        let legacyURL = directory.appendingPathComponent("chat-cache.sqlite")
        try createLegacyV2Database(at: legacyURL, gatewayID: "gw-a", commandID: "restore-on-cancel")

        databases.retryLegacyImport()

        #expect(await databases.store(gatewayID: "gw-a").loadCommands().map(\.id) == ["restore-on-cancel"])
        #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
    }

    @Test func `one broken pending removal does not block another gateway`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            let databases = try OpenClawClientDatabases(directoryURL: directory)
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
        }

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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        try databases.removeGatewayData(gatewayID: "gw-a")

        try databases.stageGatewayRemoval(gatewayID: "gw-a")
        try databases.cancelGatewayRemoval(gatewayID: "gw-a")

        let tombstoneGatewayID: String? = try await databases.stateQueue.read { db in
            try String.fetchOne(
                db,
                sql: """
                SELECT gateway_id FROM forgotten_gateways
                WHERE gateway_hash = ?
                """,
                arguments: [OpenClawClientDatabases.gatewayIdentityHash("gw-a")])
        }
        let tombstonePhase = try await databases.stateQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT cleanup_phase FROM forgotten_gateways WHERE gateway_hash = ?",
                arguments: [OpenClawClientDatabases.gatewayIdentityHash("gw-a")])
        }
        #expect(tombstoneGatewayID == nil)
        #expect(tombstonePhase == 0)

        let legacyURL = directory.appendingPathComponent("chat-cache.sqlite")
        try createLegacyV2Database(at: legacyURL, gatewayID: "gw-a", commandID: "must-not-return")
        databases.retryLegacyImport(registeredGatewayIDs: [])
        #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
        #expect(await databases.store(gatewayID: "gw-a").loadCommands().isEmpty)
    }

    @Test func `gateway removal scrubs its payloads from shared database files`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let identity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: " Per-Sender ",
            mainSessionKey: " Work ",
            defaultAgentID: " Main "))
        do {
            let databases = try OpenClawClientDatabases(directoryURL: directory)
            await databases.store(gatewayID: "gw-a").storeSessionRoutingIdentity(identity)
        }

        let reopened = try OpenClawClientDatabases(directoryURL: directory)
        #expect(reopened.loadSessionRoutingIdentity(gatewayID: "gw-a") == identity)
        #expect(identity.contract == "per-sender|work|main")
        #expect(try await reopened.stateQueue.read { db in
            try String.fetchAll(db, sql: "SELECT identifier FROM grdb_migrations")
        } == ["client-state-v1"])
    }
}

struct ClientDatabaseLegacyImportTests {
    @Test func `legacy v1 cache is discarded`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let legacyURL = directory.appendingPathComponent("chat-cache.sqlite")
        try createLegacyV2Database(at: legacyURL, gatewayID: "gw-a", commandID: "late-legacy")

        databases.retryLegacyImport()

        #expect(!FileManager.default.fileExists(atPath: legacyURL.path))
        #expect(await databases.store(gatewayID: "gw-a").loadCommands().map(\.id) == ["late-legacy"])
    }

    @Test func `forgotten gateway is never resurrected by a late legacy import`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
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
        #expect(try await databases.stateQueue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT cleanup_phase FROM forgotten_gateways WHERE gateway_hash = ?",
                arguments: [OpenClawClientDatabases.gatewayIdentityHash("gw-forgotten")])
        } == 0)

        #expect(await store.enqueueCommand(outboxCommand(id: "after-repair", text: "new pairing")))
        databases.retryLegacyImport()
        #expect(await store.loadCommands().map(\.id) == ["after-repair"])
    }

    @Test func `forget removes an unreadable per gateway legacy database and sidecars`() throws {
        let root = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let databaseDirectory = root.appendingPathComponent("databases", isDirectory: true)
        let legacyDirectory = root.appendingPathComponent("chat-cache", isDirectory: true)
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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
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
        let root = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let databaseDirectory = root.appendingPathComponent("databases", isDirectory: true)
        let legacyDirectory = root.appendingPathComponent("legacy", isDirectory: true)
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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
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
        let unknownDirectory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: unknownDirectory) }
        let unknownURL = unknownDirectory.appendingPathComponent("chat-cache.sqlite")
        try withRawDatabase(at: unknownURL) { raw in
            execute(raw, "PRAGMA user_version = 999")
        }
        _ = try OpenClawClientDatabases(directoryURL: unknownDirectory)
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

struct ChatCommandOutboxStoreTests {
    @Test func `commands and attachment blobs round trip in order`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let store = databases.store(gatewayID: "gw-a")
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
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-a")
        let now = Date().timeIntervalSince1970
        #expect(await store.enqueueCommand(outboxCommand(id: "z-first", text: "one", createdAt: now)))
        #expect(await store.enqueueCommand(outboxCommand(id: "a-second", text: "two", createdAt: now)))
        #expect(await store.claimNextCommand()?.id == "z-first")
        #expect(await store.claimNextCommand() == nil)
        #expect(await store.markCommandAwaitingConfirmation(id: "z-first") == .updated)
        #expect(await store.claimNextCommand()?.id == "a-second")
    }

    @Test func `cancellation stops only unclaimed client state`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "queued", text: "delete")))
        #expect(await store.cancelCommand(id: "queued") == .updated)
        #expect(await store.loadCommands().isEmpty)

        #expect(await store.enqueueCommand(outboxCommand(id: "claimed", text: "send")))
        #expect(await store.claimNextCommand()?.id == "claimed")
        #expect(await store.cancelCommand(id: "claimed") == .missing)
        #expect(await store.loadCommands().map(\.status) == [.sending])
    }

    @Test func `canonical proof wins a cancellation race`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "landed", text: "sent")))
        store.observeCanonicalMessageIdempotencyKeys(["landed:user"])

        #expect(await store.cancelCommand(id: "landed") == .confirmed)
        #expect(await store.loadCommands().isEmpty)
    }

    @Test func `interrupted sends fail closed once`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "interrupted", text: "maybe sent")))
        #expect(await store.claimNextCommand()?.status == .sending)
        #expect(await store.recoverInterruptedSends())
        let recovered = try #require(await store.loadCommands().first)
        #expect(recovered.status == .failed)
        #expect(recovered.lastError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
        #expect(await store.recoverInterruptedSends())
    }

    @Test func `retired facade cannot recover a replacement facades sends`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let retired = databases.store(gatewayID: "gw-a")
        #expect(await retired.enqueueCommand(outboxCommand(id: "live", text: "sending")))
        #expect(await retired.claimNextCommand()?.status == .sending)
        await retired.retire()

        #expect(await retired.recoverInterruptedSends() == false)
        let replacement = databases.store(gatewayID: "gw-a")
        #expect(await replacement.loadCommands().map(\.status) == [.sending])
    }

    @Test func `retry adopts a fresh verified route`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "retry", text: "again", status: .failed)))

        #expect(await store.markCommandRetriedIfPresent(
            id: "retry",
            agentID: "Agent-B",
            deliverySessionKey: "agent:agent-b:main",
            routingContract: "per-sender|main|agent-b") == .updated)
        let command = try #require(await store.loadCommands().first)
        #expect(command.status == .queued)
        #expect(command.agentID == "agent-b")
        #expect(command.deliverySessionKey == "agent:agent-b:main")
        #expect(command.routingContract == "per-sender|main|agent-b")
    }

    @Test func `stale queued and acknowledged commands require user action`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let store = databases.store(gatewayID: "gw-a")
        let old = Date().timeIntervalSince1970 - OpenClawChatSQLiteTranscriptCache.outboxCommandMaxAge - 1
        #expect(await store.enqueueCommand(outboxCommand(id: "old-queued", text: "old", createdAt: old)))
        #expect(await store.enqueueCommand(outboxCommand(id: "old-ack", text: "old ack")))
        #expect(await store.claimNextCommand()?.id == "old-ack")
        #expect(await store.markCommandAwaitingConfirmation(id: "old-ack") == .updated)
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

    @Test func `queue and attachment budgets are gateway scoped`() async throws {
        let directory = try makeDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
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

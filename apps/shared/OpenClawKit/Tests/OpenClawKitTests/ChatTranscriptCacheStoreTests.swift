import Foundation
import OpenClawKit
import SQLite3
import Testing
@testable import OpenClawChatUI

private func makeDatabaseURL() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("chat-cache-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("chat-cache.sqlite", isDirectory: false)
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

private func outboxCommand(
    id: String = UUID().uuidString,
    sessionKey: String = "main",
    text: String,
    attachments: [OpenClawChatOutboxAttachment] = [],
    thinking: String = "off",
    createdAt: Double = Date().timeIntervalSince1970) -> OpenClawChatOutboxCommand
{
    OpenClawChatOutboxCommand(
        id: id,
        sessionKey: sessionKey,
        text: text,
        attachments: attachments,
        thinking: thinking,
        createdAt: createdAt,
        status: .queued,
        retryCount: 0,
        lastError: nil)
}

struct ChatTranscriptCacheStoreTests {
    @Test func `verified routing identity survives a cold store reopen`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let identity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: " Per-Sender ",
            mainSessionKey: " Work ",
            defaultAgentID: " Main "))
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        await store.storeSessionRoutingIdentity(identity)
        #expect(OpenClawChatSQLiteTranscriptCache.loadSessionRoutingIdentity(
            databaseURL: url,
            gatewayID: "gw-a") == identity)

        let reopened = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await reopened.loadSessionRoutingIdentity() == identity)
        #expect(identity.contract == "per-sender|work|main")
    }

    @Test func `transcript and sessions round trip`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        let messages = [
            cacheMessage(role: "user", text: "hello", timestamp: 1000, idempotencyKey: "run-1:user"),
            cacheMessage(role: "assistant", text: "hi there", timestamp: 2000, idempotencyKey: "run-1"),
        ]
        await store.storeTranscript(sessionKey: "main", messages: messages)
        await store.storeSessions([cacheSessionEntry(key: "main", updatedAt: 2000)])

        let loaded = await store.loadTranscript(sessionKey: "main")
        #expect(messageTexts(loaded) == ["hello", "hi there"])
        #expect(loaded.map(\.role) == ["user", "assistant"])
        #expect(loaded.map(\.idempotencyKey) == ["run-1:user", "run-1"])
        #expect(loaded.map(\.timestamp) == [1000, 2000])

        let sessions = await store.loadSessions()
        #expect(sessions.map(\.key) == ["main"])

        #expect(await store.loadTranscript(sessionKey: "unknown").isEmpty)
    }

    @Test func `transcript JSON keeps only bounded diff details`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let oversizedDiff = "+1 " + String(repeating: "x", count: 64100)
        let message = OpenClawChatMessage(
            role: "toolResult",
            content: [
                OpenClawChatMessageContent(
                    type: "tool_result",
                    text: "done",
                    mimeType: nil,
                    fileName: nil,
                    content: nil,
                    arguments: AnyCodable(["oldText": AnyCodable("large proposal")]),
                    details: AnyCodable([
                        "diff": AnyCodable("+1 block diff"),
                        "ignored": AnyCodable("drop me"),
                    ]),
                    isError: true),
                OpenClawChatMessageContent(
                    type: "tool_result",
                    text: "no diff",
                    mimeType: nil,
                    fileName: nil,
                    content: nil,
                    details: AnyCodable(["ignored": AnyCodable("drop me")])),
            ],
            timestamp: 1,
            details: AnyCodable([
                "diff": AnyCodable(oversizedDiff),
                "ignored": AnyCodable("drop me"),
            ]),
            isError: true)

        let cacheable = try #require(OpenClawChatSQLiteTranscriptCache.cacheableMessages([message]).first)
        #expect(cacheable.content.allSatisfy { $0.arguments == nil })
        #expect(Set(cacheable.details?.dictionaryValue?.keys.map(\.self) ?? []) == ["diff"])
        #expect(cacheable.details?.dictionaryValue?["diff"]?.stringValue?.utf16.count == 64000)
        #expect(cacheable.details?.dictionaryValue?["diff"]?.stringValue?.hasSuffix("\n...(truncated)...") == true)
        #expect(Set(cacheable.content[0].details?.dictionaryValue?.keys.map(\.self) ?? []) == ["diff"])
        #expect(cacheable.content[1].details == nil)
        #expect(cacheable.isError == true)
        #expect(cacheable.content[0].isError == true)

        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        await store.storeTranscript(sessionKey: "main", messages: [message])
        let decoded = try #require(await store.loadTranscript(sessionKey: "main").first)
        #expect(decoded.details == cacheable.details)
        #expect(decoded.content[0].details == cacheable.content[0].details)
        #expect(ChatToolDiff.resolveDiff(name: "edit", arguments: nil, details: decoded.details)?.stat == nil)
    }

    @Test func `transcript keeps only most recent messages within bound`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxCachedMessagesPerSession

        let messages = (0..<(bound + 50)).map { index in
            cacheMessage(role: "user", text: "m\(index)", timestamp: Double(index))
        }
        await store.storeTranscript(sessionKey: "main", messages: messages)

        let loaded = await store.loadTranscript(sessionKey: "main")
        #expect(loaded.count == bound)
        #expect(messageTexts(loaded).first == "m50")
        #expect(messageTexts(loaded).last == "m\(bound + 49)")
    }

    @Test func `sessions list is bounded to most recently updated`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxCachedSessions

        let sessions = (0..<(bound + 10)).map { index in
            cacheSessionEntry(key: "s\(index)", updatedAt: Double(index))
        }
        await store.storeSessions(sessions)

        let loaded = await store.loadSessions()
        #expect(loaded.count == bound)
        // Highest updatedAt survives, oldest entries are dropped.
        #expect(loaded.map(\.key).contains("s\(bound + 9)"))
        #expect(!loaded.map(\.key).contains("s0"))
    }

    @Test func `transcript eviction keeps most recent sessions`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxCachedTranscripts

        for index in 0..<(bound + 5) {
            await store.storeTranscript(
                sessionKey: "s\(index)",
                messages: [cacheMessage(role: "user", text: "m\(index)", timestamp: Double(index))])
        }

        // The five oldest transcripts were evicted; the newest ones remain.
        for index in 0..<5 {
            #expect(await store.loadTranscript(sessionKey: "s\(index)").isEmpty)
        }
        for index in 5..<(bound + 5) {
            #expect(await !(store.loadTranscript(sessionKey: "s\(index)").isEmpty))
        }
    }

    @Test func `transcripts are scoped per gateway identity`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")

        await storeA.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway A secret", timestamp: 1)])
        await storeA.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])

        #expect(await storeB.loadTranscript(sessionKey: "main").isEmpty)
        #expect(await storeB.loadSessions().isEmpty)

        await storeB.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway B", timestamp: 2)])
        #expect(await messageTexts(storeA.loadTranscript(sessionKey: "main")) == ["gateway A secret"])
        #expect(await messageTexts(storeB.loadTranscript(sessionKey: "main")) == ["gateway B"])
    }

    @Test func `global transcripts are scoped per agent identity`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        await store.storeTranscript(
            sessionKey: "global",
            agentID: "agent-a",
            messages: [cacheMessage(
                role: "user",
                text: "agent A",
                timestamp: 1,
                idempotencyKey: "c-agent-a:user")])
        await store.storeTranscript(
            sessionKey: "global",
            agentID: "agent-b",
            messages: [cacheMessage(role: "user", text: "agent B", timestamp: 2)])

        let agentAMessages = await store.loadTranscript(sessionKey: "global", agentID: "agent-a")
        let agentBMessages = await store.loadTranscript(sessionKey: "global", agentID: "agent-b")
        #expect(messageTexts(agentAMessages) == ["agent A"])
        #expect(messageTexts(agentBMessages) == ["agent B"])
        #expect(await store.loadTranscript(sessionKey: "global").isEmpty)

        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "c-agent-a",
            sessionKey: "global",
            agentID: "agent-a",
            text: "agent A",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)))
        #expect(await store.cancelCommand(id: "c-agent-a") == .updated)
        #expect(await store.loadTranscript(sessionKey: "global", agentID: "agent-a").isEmpty)
        let survivingAgentBMessages = await store.loadTranscript(sessionKey: "global", agentID: "agent-b")
        #expect(messageTexts(survivingAgentBMessages) == ["agent B"])
    }

    @Test func `empty transcript store clears cached row`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "old", timestamp: 1)])
        await store.storeTranscript(sessionKey: "main", messages: [])
        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
    }

    @Test func `reset retirement permits physical removal of all gateway rows`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")
        await storeA.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway A", timestamp: 1)])
        await storeA.storeSessions([cacheSessionEntry(key: "main", updatedAt: 1)])
        await storeB.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "gateway B", timestamp: 2)])

        await storeA.retire()
        await storeB.retire()
        OpenClawChatSQLiteTranscriptCache.removeDatabaseFiles(at: url)
        await storeA.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "late write", timestamp: 3)])

        let readerA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let readerB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")
        #expect(await storeA.loadTranscript(sessionKey: "main").isEmpty)
        #expect(await storeA.loadSessions().isEmpty)
        #expect(await readerA.loadTranscript(sessionKey: "main").isEmpty)
        #expect(await readerB.loadTranscript(sessionKey: "main").isEmpty)
    }

    @Test func `removing one gateway database preserves another`() async throws {
        let urlA = try makeDatabaseURL()
        let directory = urlA.deletingLastPathComponent()
        let urlB = directory.appendingPathComponent("chat-cache-b.sqlite", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: urlA, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: urlB, gatewayID: "gw-b")
        await storeA.storeSessions([cacheSessionEntry(key: "a", updatedAt: 1)])
        await storeA.storeTranscript(
            sessionKey: "a",
            messages: [cacheMessage(role: "user", text: "gateway A", timestamp: 1)])
        await storeB.storeSessions([cacheSessionEntry(key: "b", updatedAt: 2)])
        await storeB.storeTranscript(
            sessionKey: "b",
            messages: [cacheMessage(role: "user", text: "gateway B", timestamp: 2)])

        await storeA.retire()
        OpenClawChatSQLiteTranscriptCache.removeDatabaseFiles(at: urlA)

        let readerA = OpenClawChatSQLiteTranscriptCache(databaseURL: urlA, gatewayID: "gw-a")
        #expect(await readerA.loadSessions().isEmpty)
        #expect(await readerA.loadTranscript(sessionKey: "a").isEmpty)
        #expect(await storeB.loadSessions().map(\.key) == ["b"])
        #expect(await messageTexts(storeB.loadTranscript(sessionKey: "b")) == ["gateway B"])
    }

    @Test func `attachment payloads are not persisted`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")

        let message = OpenClawChatMessage(
            role: "user",
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: "See attached.",
                    mimeType: nil,
                    fileName: nil,
                    content: nil),
                OpenClawChatMessageContent(
                    type: "image",
                    text: nil,
                    mimeType: "image/png",
                    fileName: "photo.png",
                    content: AnyCodable("aGVsbG8tYmluYXJ5LWJsb2I=")),
            ],
            timestamp: 1000)
        await store.storeTranscript(sessionKey: "main", messages: [message])

        let loaded = await store.loadTranscript(sessionKey: "main")
        let items = try #require(loaded.first?.content)
        #expect(items.count == 2)
        // Text and small descriptors survive; binary payloads never hit disk.
        #expect(items[0].text == "See attached.")
        #expect(items[1].fileName == "photo.png")
        #expect(items[1].content == nil)
    }

    @Test func `v1 transcript cache migrates to durable outbox schema`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            await store.storeTranscript(
                sessionKey: "main",
                messages: [cacheMessage(role: "user", text: "old-schema", timestamp: 1)])
            await store.retire()
        }

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "DROP TABLE outbox_commands", nil, nil, nil) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "PRAGMA user_version = 1", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let migrated = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await messageTexts(migrated.loadTranscript(sessionKey: "main")) == ["old-schema"])
        #expect(await migrated.enqueueCommand(outboxCommand(id: "c-1", text: "preserved migration")))
        #expect(await migrated.loadCommands().map(\.text) == ["preserved migration"])
    }

    @Test func `v2 migration parks rows without a routing contract`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let now = Date().timeIntervalSince1970
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
                id: "c-global",
                sessionKey: "global",
                agentID: "agent-a",
                text: "targeted before downgrade",
                thinking: "off",
                createdAt: now,
                status: .queued,
                retryCount: 0,
                lastError: nil)))
            #expect(await store.enqueueCommand(outboxCommand(
                id: "c-main",
                sessionKey: "main",
                text: "mutable main alias",
                createdAt: now + 0.5)))
            #expect(await store.enqueueCommand(outboxCommand(
                id: "c-scoped",
                sessionKey: "agent:agent-a:main",
                text: "already scoped",
                createdAt: now + 1)))
            #expect(await store.enqueueCommand(outboxCommand(
                id: "c-matrix",
                sessionKey: "agent:agent-a:matrix:channel:!MixedRoomAbCdEf:example.org",
                text: "case-sensitive room",
                createdAt: now + 2)))
            #expect(await store.enqueueCommand(outboxCommand(
                id: "c-empty-agent",
                sessionKey: "agent::main",
                text: "missing agent",
                createdAt: now + 3)))
            #expect(await store.enqueueCommand(outboxCommand(
                id: "c-empty-rest",
                sessionKey: "agent:agent-a:",
                text: "missing session",
                createdAt: now + 4)))
            await store.retire()
        }

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "UPDATE outbox_commands SET status = 'sending' WHERE client_uuid = 'c-scoped'",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "UPDATE outbox_commands SET status = 'awaiting_confirmation' WHERE client_uuid = 'c-matrix'",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "ALTER TABLE outbox_commands DROP COLUMN agent_id", nil, nil, nil) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN delivery_session_key",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN routing_contract",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN attachment_bytes",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN attachments",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "PRAGMA user_version = 2", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let migrated = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let commands = await migrated.loadCommands()
        #expect(commands.map(\.agentID) == [nil, nil, nil, nil, nil, nil])
        #expect(commands.map(\.deliverySessionKey) == [
            "",
            "",
            "",
            "",
            "",
            "",
        ])
        #expect(commands.map(\.status) == [.failed, .failed, .failed, .failed, .failed, .failed])
        #expect(commands.map(\.lastError) == [
            OpenClawChatSQLiteTranscriptCache.outboxUnknownTargetError,
            OpenClawChatSQLiteTranscriptCache.outboxUnknownTargetError,
            OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError,
            OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError,
            OpenClawChatSQLiteTranscriptCache.outboxUnknownTargetError,
            OpenClawChatSQLiteTranscriptCache.outboxUnknownTargetError,
        ])
        #expect(await migrated.markCommandRetriedIfPresent(
            id: "c-global",
            agentID: "agent-b",
            deliverySessionKey: "global",
            routingContract: "per-sender|main|agent-b") == .updated)
        let retried = await migrated.loadCommands().first { $0.id == "c-global" }
        #expect(retried?.agentID == "agent-b")
        #expect(retried?.deliverySessionKey == "global")
        #expect(retried?.routingContract == "per-sender|main|agent-b")
        #expect(retried?.status == .queued)
    }

    @Test func `unknown failed command can retry without an agent`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "c-unknown",
            sessionKey: "unknown",
            deliverySessionKey: "unknown",
            routingContract: "per-sender|main|main",
            agentID: nil,
            text: "retry reserved",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970,
            status: .failed,
            retryCount: 1,
            lastError: "failed")))
        #expect(await store.loadCommands().first?.lastError == "failed")

        #expect(await store.markCommandRetriedIfPresent(
            id: "c-unknown",
            agentID: nil,
            deliverySessionKey: "unknown",
            routingContract: "per-sender|main|main") == .updated)
        let command = try #require(await store.loadCommands().first)
        #expect(command.status == .queued)
        #expect(command.agentID == nil)
        #expect(command.deliverySessionKey == "unknown")
    }

    @Test func `retargeted retry removes optimistic row from previous agent cache`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        await store.storeTranscript(
            sessionKey: "main",
            agentID: "agent-a",
            messages: [
                cacheMessage(
                    role: "user",
                    text: "old owner",
                    timestamp: 1,
                    idempotencyKey: "c-retarget:user"),
            ])
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "c-retarget",
            sessionKey: "main",
            deliverySessionKey: "agent:agent-a:main",
            routingContract: "per-sender|main|agent-a",
            agentID: "agent-a",
            text: "old owner",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970,
            status: .failed,
            retryCount: 1,
            lastError: "changed")))

        #expect(await store.markCommandRetriedIfPresent(
            id: "c-retarget",
            agentID: "agent-b",
            deliverySessionKey: "agent:agent-b:main",
            routingContract: "per-sender|main|agent-b") == .updated)
        #expect(await store.loadTranscript(sessionKey: "main", agentID: "agent-a").isEmpty)
        let command = try #require(await store.loadCommands().first)
        #expect(command.agentID == "agent-b")
        #expect(command.status == .queued)
    }

    @Test func `v3 migration preserves delivery ambiguity without a routing contract`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
                id: "c-v3",
                sessionKey: "main",
                deliverySessionKey: "agent:agent-a:main",
                routingContract: "per-sender|main|agent-a",
                agentID: "agent-a",
                text: "park after downgrade",
                thinking: "off",
                createdAt: Date().timeIntervalSince1970,
                status: .queued,
                retryCount: 0,
                lastError: nil)))
            #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
                id: "c-v3-acked",
                sessionKey: "main",
                deliverySessionKey: "agent:agent-a:main",
                routingContract: "per-sender|main|agent-a",
                agentID: "agent-a",
                text: "possibly delivered",
                thinking: "off",
                createdAt: Date().timeIntervalSince1970 + 1,
                status: .awaitingConfirmation,
                retryCount: 0,
                lastError: nil)))
            await store.retire()
        }

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN routing_contract",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN attachment_bytes",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN attachments",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "PRAGMA user_version = 3", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let migrated = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let commands = await migrated.loadCommands()
        #expect(commands.map(\.status) == [.failed, .failed])
        #expect(commands.map(\.agentID) == [nil, nil])
        #expect(commands.map(\.deliverySessionKey) == ["", ""])
        #expect(commands.map(\.routingContract) == [nil, nil])
        #expect(commands.map(\.lastError) == [
            OpenClawChatSQLiteTranscriptCache.outboxUnknownTargetError,
            OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError,
        ])
    }

    @Test func `v4 migration adds routing identity and attachment storage`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(outboxCommand(id: "c-v4", text: "preserve me")))
            await store.retire()
        }

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "DROP TABLE gateway_routing_identity", nil, nil, nil) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN attachment_bytes",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN attachments",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "PRAGMA user_version = 4", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let migrated = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await migrated.loadCommands().map(\.id) == ["c-v4"])
        #expect(await migrated.loadSessionRoutingIdentity() == nil)
        let identity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "global",
            mainSessionKey: "main",
            defaultAgentID: "main"))
        await migrated.storeSessionRoutingIdentity(identity)
        #expect(await migrated.loadSessionRoutingIdentity() == identity)
    }

    @Test func `v5 migration preserves commands while adding attachment storage`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(outboxCommand(id: "c-v5", text: "preserve me")))
            await store.retire()
        }

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN attachment_bytes",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands DROP COLUMN attachments",
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "PRAGMA user_version = 5", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let migrated = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let command = try #require(await migrated.loadCommands().first)
        #expect(command.id == "c-v5")
        #expect(command.attachments.isEmpty)
    }

    @Test func `unknown schema preserves durable outbox bytes and fails closed`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(outboxCommand(id: "c-1", text: "do not delete")))
            await store.retire()
        }

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(raw, "PRAGMA user_version = 99", nil, nil, nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let blocked = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await blocked.loadCommands().isEmpty)
        #expect(await !blocked.enqueueCommand(outboxCommand(id: "c-2", text: "must fail closed")))

        // Restore the known version to prove the blocked open did not delete
        // or rebuild the persistent outbox table.
        raw = nil
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "PRAGMA user_version = \(OpenClawChatSQLiteTranscriptCache.schemaVersion)",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)
        let recovered = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await recovered.loadCommands().map(\.text) == ["do not delete"])
    }

    @Test func `corrupt existing database is preserved and fails closed`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let original = Data("this is not a sqlite database".utf8)
        try original.write(to: url)

        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "recovered", timestamp: 1)])
        #expect(await store.loadTranscript(sessionKey: "main").isEmpty)
        #expect(try Data(contentsOf: url) == original)
    }

    @Test func `undecodable row is dropped and treated as miss`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(role: "user", text: "seed", timestamp: 1)])

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "UPDATE cached_transcripts SET payload = '{not json' WHERE session_key = 'main'",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        let reader = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await reader.loadTranscript(sessionKey: "main").isEmpty)
        // The bad row was deleted, not just skipped.
        #expect(await reader.loadTranscript(sessionKey: "main").isEmpty)
    }
}

struct ChatCommandOutboxStoreTests {
    @Test func `outbox commands round trip in createdAt order across store instances`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        // Recent timestamps: rows older than the staleness gate would expire.
        let now = Date().timeIntervalSince1970
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(
                outboxCommand(id: "c-2", text: "second", thinking: "high", createdAt: now - 10)))
            #expect(await store.enqueueCommand(
                outboxCommand(id: "c-1", text: "first", thinking: "off", createdAt: now - 20)))
        }

        // New instance = simulated app relaunch: rows are durable.
        let reopened = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let loaded = await reopened.loadCommands()
        #expect(loaded.map(\.id) == ["c-1", "c-2"])
        #expect(loaded.map(\.text) == ["first", "second"])
        #expect(loaded.map(\.thinking) == ["off", "high"])
        #expect(loaded.map(\.status) == [.queued, .queued])
        #expect(loaded.map(\.retryCount) == [0, 0])
        #expect(loaded.map(\.lastError) == [nil, nil])
        #expect(loaded.map(\.sessionKey) == ["main", "main"])
    }

    @Test func `claims are FIFO and exclusive until the sender advances`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let now = Date().timeIntervalSince1970
        #expect(await store.enqueueCommand(outboxCommand(id: "c-1", text: "first", createdAt: now)))
        #expect(await store.enqueueCommand(outboxCommand(id: "c-2", text: "second", createdAt: now + 1)))

        #expect(await store.claimNextCommand()?.id == "c-1")
        #expect(await store.claimNextCommand() == nil)
        #expect(await store.markCommandAwaitingConfirmation(id: "c-1") == .updated)
        #expect(await store.claimNextCommand()?.id == "c-2")
    }

    @Test func `user cancellation cannot delete a claimed command`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-1", text: "claimed")))
        #expect(await store.claimNextCommand()?.id == "c-1")

        #expect(await store.cancelCommand(id: "c-1") == .missing)
        #expect(await store.loadCommands().map(\.status) == [.sending])
        #expect(await store.confirmCommand(id: "c-1") == .updated)
        #expect(await store.loadCommands().isEmpty)
    }

    @Test func `queued cancellation atomically scrubs and suppresses its cached bubble`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-cancel", text: "cancel me")))
        let staleSnapshot = [
            cacheMessage(
                role: "user",
                text: "cancel me",
                timestamp: 1,
                idempotencyKey: "c-cancel:user"),
            cacheMessage(
                role: "assistant",
                text: "newer row",
                timestamp: 2,
                idempotencyKey: "other-run"),
        ]
        await store.storeTranscript(sessionKey: "main", messages: staleSnapshot)

        #expect(await store.cancelCommand(id: "c-cancel") == .updated)
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["newer row"])

        // An overlapping view can finish a stale whole-transcript write after
        // cancellation. The cache owner keeps the canceled UUID suppressed.
        await store.storeTranscript(sessionKey: "main", messages: staleSnapshot)
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["newer row"])

        // Canonical history can prove an ambiguous send really landed. That
        // authoritative row clears suppression and remains cacheable offline.
        await store.storeCanonicalTranscript(
            sessionKey: "main",
            messages: staleSnapshot,
            canonicalMessageIdempotencyKeys: ["c-cancel:user"])
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["cancel me", "newer row"])

        #expect(await store.enqueueCommand(outboxCommand(id: "c-canonical-first", text: "already landed")))
        let canonicalFirst = [cacheMessage(
            role: "user",
            text: "already landed",
            timestamp: 3,
            idempotencyKey: "c-canonical-first:user")]
        await store.storeCanonicalTranscript(
            sessionKey: "main",
            messages: canonicalFirst,
            canonicalMessageIdempotencyKeys: ["c-canonical-first:user"])
        #expect(await store.cancelCommand(id: "c-canonical-first") == .confirmed)
        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["already landed"])
    }

    @Test func `canonical message merge preserves a newer cached snapshot`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        await store.storeTranscript(sessionKey: "main", messages: [
            cacheMessage(role: "assistant", text: "newer row", timestamp: 2, idempotencyKey: "newer-run"),
        ])

        await store.mergeCanonicalTranscriptMessage(
            sessionKey: "main",
            agentID: nil,
            message: cacheMessage(
                role: "user",
                text: "confirmed row",
                timestamp: 1,
                idempotencyKey: "confirmed:user"),
            canonicalMessageIdempotencyKey: "confirmed:user")

        #expect(await messageTexts(store.loadTranscript(sessionKey: "main")) == ["confirmed row", "newer row"])
    }

    @Test func `scoped cancellation scrubs the canonical transcript partition`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let sessionKey = "agent:agent-a:matrix:channel:!MixedRoomAbCdEf:example.org"
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "c-scoped-cancel",
            sessionKey: sessionKey,
            agentID: "agent-a",
            text: "cancel scoped",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)))
        let staleSnapshot = [cacheMessage(
            role: "user",
            text: "cancel scoped",
            timestamp: 1,
            idempotencyKey: "c-scoped-cancel:user")]
        await store.storeTranscript(sessionKey: sessionKey, messages: staleSnapshot)

        #expect(await store.cancelCommand(id: "c-scoped-cancel") == .updated)
        #expect(await store.loadTranscript(sessionKey: sessionKey).isEmpty)

        await store.storeTranscript(sessionKey: sessionKey, messages: staleSnapshot)
        #expect(await store.loadTranscript(sessionKey: sessionKey).isEmpty)
    }

    @Test func `cancellation lookup failure preserves the queued command`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-lookup", text: "keep me")))

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands RENAME TO outbox_commands_unavailable",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        #expect(await store.cancelCommand(id: "c-lookup") == .unavailable)

        raw = nil
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands_unavailable RENAME TO outbox_commands",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)
        #expect(await store.loadCommands().map(\.id) == ["c-lookup"])
    }

    @Test func `transcript lookup failure rolls back queued cancellation`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-cache", text: "keep me")))
        await store.storeTranscript(
            sessionKey: "main",
            messages: [cacheMessage(
                role: "user",
                text: "keep me",
                timestamp: 1,
                idempotencyKey: "c-cache:user")])

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE cached_transcripts RENAME TO cached_transcripts_unavailable",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        #expect(await store.cancelCommand(id: "c-cache") == .unavailable)
        #expect(await store.loadCommands().map(\.id) == ["c-cache"])
    }

    @Test func `interrupted sending rows fail closed on recovery`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(outboxCommand(id: "c-1", text: "in flight")))
            #expect(await store.claimNextCommand()?.id == "c-1")
            #expect(await store.loadCommands().map(\.status) == [.sending])
        }

        // Simulated crash mid-send: the durable result is ambiguous, so a
        // fresh process requires explicit user retry instead of replaying it.
        let reopened = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await reopened.recoverInterruptedSends())
        let recovered = await reopened.loadCommands()
        #expect(recovered.map(\.status) == [.failed])
        #expect(recovered.map(\.lastError) == [OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError])

        // An unreachable store must report failure so callers do not burn
        // their once-per-launch recovery gate while the DB is locked.
        await reopened.retire()
        #expect(await !reopened.recoverInterruptedSends())
    }

    @Test func `failed post-claim transition reopens same-process recovery`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-claim", text: "recover me")))
        #expect(await store.recoverInterruptedSends())
        #expect(await store.claimNextCommand()?.id == "c-claim")

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands RENAME TO outbox_commands_unavailable",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        #expect(await store.markCommandAwaitingConfirmation(id: "c-claim") == .unavailable)

        raw = nil
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands_unavailable RENAME TO outbox_commands",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        #expect(await store.recoverInterruptedSends())
        #expect(await store.loadCommands().map(\.status) == [.failed])
    }

    @Test func `failed terminal transition reports unavailable and reopens recovery`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-terminal", text: "stop retrying")))
        #expect(await store.recoverInterruptedSends())
        #expect(await store.claimNextCommand()?.id == "c-terminal")

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands RENAME TO outbox_commands_unavailable",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        #expect(
            await store.markCommandFailedIfPresent(id: "c-terminal", retryCount: 3, lastError: "rejected") ==
                .unavailable)

        raw = nil
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            "ALTER TABLE outbox_commands_unavailable RENAME TO outbox_commands",
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        #expect(await store.recoverInterruptedSends())
        let command = await store.loadCommands().first
        #expect(command?.status == .failed)
        #expect(command?.retryCount == 0)
        #expect(command?.lastError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
    }

    @Test func `unknown row status is skipped without blocking later commands`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-valid", text: "send me", createdAt: 2)))

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            """
            INSERT INTO outbox_commands(
                client_uuid, gateway_id, session_key, text, thinking, created_at, status, retry_count, last_error
            ) VALUES ('c-unknown', 'gw-a', 'main', 'skip me', 'off', 1, 'future_status', 0, '')
            """,
            nil,
            nil,
            nil) == SQLITE_OK)
        sqlite3_close_v2(raw)

        #expect(await store.loadCommands().map(\.id) == ["c-valid"])
    }

    @Test func `queued commands expire to failed at the staleness boundary`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let now = Date().timeIntervalSince1970
        let maxAge = OpenClawChatSQLiteTranscriptCache.outboxCommandMaxAge
        #expect(await store.enqueueCommand(
            outboxCommand(id: "c-stale", text: "stale", createdAt: now - maxAge - 60)))
        #expect(await store.enqueueCommand(
            outboxCommand(id: "c-fresh", text: "fresh", createdAt: now - maxAge + 60)))
        #expect(await store.enqueueCommand(
            OpenClawChatOutboxCommand(
                id: "c-unconfirmed",
                sessionKey: "main",
                text: "unconfirmed",
                thinking: "off",
                createdAt: now - maxAge - 60,
                status: .sending,
                retryCount: 0,
                lastError: nil)))
        #expect(await store.markCommandAwaitingConfirmation(id: "c-unconfirmed") == .updated)

        let loaded = await store.loadCommands()
        let stale = try #require(loaded.first { $0.id == "c-stale" })
        let fresh = try #require(loaded.first { $0.id == "c-fresh" })
        let unconfirmed = try #require(loaded.first { $0.id == "c-unconfirmed" })
        #expect(stale.status == .failed)
        #expect(stale.lastError == OpenClawChatSQLiteTranscriptCache.outboxExpiredError)
        #expect(fresh.status == .queued)
        #expect(fresh.lastError == nil)
        #expect(unconfirmed.status == .failed)
        #expect(unconfirmed.lastError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
    }

    @Test func `enqueue refuses beyond the queue bound`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let bound = OpenClawChatSQLiteTranscriptCache.maxQueuedCommands

        for index in 0..<bound {
            #expect(await store.enqueueCommand(outboxCommand(id: "c-\(index)", text: "m\(index)")))
        }
        #expect(await !store.enqueueCommand(outboxCommand(id: "c-overflow", text: "one too many")))
        #expect(await store.loadCommands().count == bound)

        // Deleting a row frees capacity again.
        #expect(await store.cancelCommand(id: "c-0") == .updated)
        #expect(await store.enqueueCommand(outboxCommand(id: "c-after-delete", text: "fits now")))
    }

    @Test func `attachment byte admission enforces command and gateway bounds`() {
        let commandBound = OpenClawChatSQLiteTranscriptCache.maxAttachmentBytesPerCommand
        let gatewayBound = OpenClawChatSQLiteTranscriptCache.maxQueuedAttachmentBytes

        #expect(OpenClawChatSQLiteTranscriptCache.canEnqueueAttachmentBytes(
            commandBytes: commandBound,
            queuedBytes: gatewayBound - commandBound))
        #expect(!OpenClawChatSQLiteTranscriptCache.canEnqueueAttachmentBytes(
            commandBytes: commandBound + 1,
            queuedBytes: 0))
        #expect(!OpenClawChatSQLiteTranscriptCache.canEnqueueAttachmentBytes(
            commandBytes: 1,
            queuedBytes: gatewayBound))
        #expect(!OpenClawChatSQLiteTranscriptCache.canEnqueueAttachmentBytes(
            commandBytes: -1,
            queuedBytes: 0))
    }

    @Test func `enqueue persists attachment bytes and refuses a full byte budget`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let attachment = OpenClawChatOutboxAttachment(
            type: "file",
            mimeType: "audio/mp4",
            fileName: "voice-note.m4a",
            data: Data([0x01]))
        do {
            let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
            #expect(await store.enqueueCommand(outboxCommand(
                id: "c-audio",
                text: "voice note",
                attachments: [attachment])))
            await store.retire()
        }

        var raw: OpaquePointer?
        #expect(sqlite3_open(url.path, &raw) == SQLITE_OK)
        #expect(sqlite3_exec(
            raw,
            """
            UPDATE outbox_commands
            SET attachment_bytes = \(OpenClawChatSQLiteTranscriptCache.maxQueuedAttachmentBytes)
            WHERE client_uuid = 'c-audio' AND attachment_bytes = 1
            """,
            nil,
            nil,
            nil) == SQLITE_OK)
        #expect(sqlite3_changes(raw) == 1)
        sqlite3_close_v2(raw)

        let fullStore = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await !fullStore.enqueueCommand(outboxCommand(
            id: "c-overflow",
            text: "one byte too many",
            attachments: [attachment])))
        #expect(await fullStore.loadCommands().map(\.id) == ["c-audio"])
    }

    @Test func `outbox rows are scoped per gateway identity`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let storeA = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        let storeB = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-b")

        #expect(await storeA.enqueueCommand(outboxCommand(id: "c-a", text: "for gateway A")))
        #expect(await storeB.loadCommands().isEmpty)

        // Cross-gateway mutations must not leak either.
        #expect(
            await storeB.markCommandFailedIfPresent(id: "c-a", retryCount: 3, lastError: "boom") == .missing)
        #expect(await storeB.cancelCommand(id: "c-a") == .missing)
        let survivors = await storeA.loadCommands()
        #expect(survivors.map(\.id) == ["c-a"])
        #expect(survivors.map(\.status) == [.queued])
    }

    @Test func `retry and failure marks persist retry count and last error`() async throws {
        let url = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = OpenClawChatSQLiteTranscriptCache(databaseURL: url, gatewayID: "gw-a")
        #expect(await store.enqueueCommand(outboxCommand(id: "c-1", text: "retry me")))

        await store.markCommandQueued(id: "c-1", retryCount: 2, lastError: "socket closed")
        var loaded = await store.loadCommands()
        #expect(loaded.map(\.status) == [.queued])
        #expect(loaded.map(\.retryCount) == [2])
        #expect(loaded.map(\.lastError) == ["socket closed"])

        #expect(await store.claimNextCommand()?.id == "c-1")
        #expect(await store.markCommandFailedIfPresent(
            id: "c-1",
            retryCount: 3,
            lastError: "gave up") == .updated)
        loaded = await store.loadCommands()
        #expect(loaded.map(\.status) == [.failed])
        #expect(loaded.map(\.retryCount) == [3])
        #expect(loaded.map(\.lastError) == ["gave up"])

        #expect(await store.cancelCommand(id: "c-1") == .updated)
        #expect(await store.loadCommands().isEmpty)
    }
}

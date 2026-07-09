import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct NodePairingApprovalPrompterTests {
    @Test func `silent pairing requires a trusted SSH host key`() {
        let options = NodePairingApprovalPrompter._testSilentPairingSSHOptions()

        #expect(options.contains("BatchMode=yes"))
        #expect(options.contains("ControlMaster=no"))
        #expect(options.contains("ControlPath=none"))
        #expect(options.contains("ControlPersist=no"))
        #expect(options.contains("ForkAfterAuthentication=no"))
        #expect(options.contains("StrictHostKeyChecking=yes"))
        #expect(!options.contains("StrictHostKeyChecking=accept-new"))
    }

    @Test func `own node is automatically approved only for a local gateway`() {
        #expect(NodePairingApprovalPrompter.shouldAutoApproveOwnLocalNode(
            connectionMode: .local,
            requestNodeId: "node-1",
            localNodeId: "node-1"))
        #expect(!NodePairingApprovalPrompter.shouldAutoApproveOwnLocalNode(
            connectionMode: .remote,
            requestNodeId: "node-1",
            localNodeId: "node-1"))
        #expect(!NodePairingApprovalPrompter.shouldAutoApproveOwnLocalNode(
            connectionMode: .local,
            requestNodeId: "node-2",
            localNodeId: "node-1"))
    }

    @Test func `node pairing approval prompter exercises`() async {
        await NodePairingApprovalPrompter.exerciseForTesting()
    }

    @Test func `a newer device pairing request supersedes queued requests for the same device`() {
        func request(_ requestId: String, deviceId: String, ts: Double) -> DevicePairingApprovalPrompter
            .PendingRequest
        {
            DevicePairingApprovalPrompter.PendingRequest(
                requestId: requestId,
                deviceId: deviceId,
                publicKey: "pub",
                displayName: nil,
                platform: "MacIntel",
                clientId: nil,
                clientMode: nil,
                role: "node",
                scopes: nil,
                remoteIp: nil,
                silent: nil,
                isRepair: true,
                ts: ts)
        }

        let stale1 = request("req-1", deviceId: "device-a", ts: 1)
        let stale2 = request("req-2", deviceId: "device-a", ts: 2)
        let other = request("req-3", deviceId: "device-b", ts: 3)
        let fresh = request("req-4", deviceId: "device-a", ts: 4)

        // Stale requests for the same device collapse; other devices are untouched.
        let coalesced = DevicePairingApprovalPrompter.coalescedQueue([stale1, stale2, other], adding: fresh)
        #expect(coalesced?.map(\.requestId) == ["req-3", "req-4"])

        // Re-delivery of an already queued requestId is a no-op.
        #expect(DevicePairingApprovalPrompter.coalescedQueue([stale1, other], adding: stale1) == nil)
    }
}

@MainActor
struct PairingCardPresentationTests {
    private func nodeCard(
        displayName: String? = "Peter's MacBook Pro",
        platform: String? = "macos 26.5",
        modelIdentifier: String? = "MacBookPro18,3",
        caps: [String] = [],
        commands: [String] = [],
        previouslyPaired: Bool? = false) -> PairingApprovalCenter.Card
    {
        PairingApprovalCenter.Card(
            kind: .node,
            requestId: "req-1",
            subjectId: "19cec1c3301a7469d4fd71f5f81339508390dadda91b34aee15faf2849dccdc7",
            displayName: displayName,
            platform: platform,
            deviceFamily: "Mac",
            modelIdentifier: modelIdentifier,
            version: "2026.6.11",
            coreVersion: "2026.6.10",
            remoteIp: "::ffff:192.168.1.42",
            role: nil,
            scopes: [],
            caps: caps,
            commands: commands,
            isRepair: false,
            previouslyPaired: previouslyPaired,
            requestedAt: Date(timeIntervalSince1970: 1_700_000_000))
    }

    private func deviceCard(scopes: [String], isRepair: Bool = false) -> PairingApprovalCenter.Card {
        PairingApprovalCenter.Card(
            kind: .device,
            requestId: "req-2",
            subjectId: "4a865684dbfa7b7937bd333813476ca88b672c2d02ad08fc52b80d88af4e82bd",
            displayName: nil,
            platform: "MacIntel",
            deviceFamily: nil,
            modelIdentifier: nil,
            version: nil,
            coreVersion: nil,
            remoteIp: "192.0.2.10",
            role: "operator",
            scopes: scopes,
            caps: [],
            commands: [],
            isRepair: isRepair,
            previouslyPaired: false,
            requestedAt: Date(timeIntervalSince1970: 1_700_000_000))
    }

    @Test func `card copy summarizes the requesting hardware`() {
        let card = self.nodeCard()
        #expect(PairingCardPresentation.title(for: card) == "Peter's MacBook Pro")
        #expect(PairingCardPresentation.subtitle(for: card) == "macOS 26.5 · MacBookPro18,3")
        #expect(PairingCardPresentation.deviceSymbol(for: card) == "macbook")
        #expect(PairingCardPresentation.identityLine(for: card) == "ID 19cec1c3...9dccdc7 · 192.168.1.42")
        #expect(PairingCardPresentation.versionTooltip(for: card) == "App 2026.6.11 · Core 2026.6.10")
        #expect(PairingCardPresentation.headerSummary(for: [card]) == "A node wants to connect to OpenClaw.")
    }

    @Test func `device symbols map hardware families`() {
        #expect(PairingCardPresentation.deviceSymbol(for: self.deviceCard(scopes: [])) == "laptopcomputer")
        let iphone = PairingApprovalCenter.Card(
            kind: .device, requestId: "r", subjectId: "d", displayName: nil,
            platform: "ios 26", deviceFamily: nil, modelIdentifier: nil, version: nil,
            coreVersion: nil, remoteIp: nil, role: nil, scopes: [], caps: [], commands: [],
            isRepair: false, previouslyPaired: false, requestedAt: Date(timeIntervalSince1970: 0))
        #expect(PairingCardPresentation.deviceSymbol(for: iphone) == "iphone")
    }

    @Test func `node access rows flag command execution as elevated`() {
        let card = self.nodeCard(caps: ["screen", "camera"], commands: ["system.run", "system.notify"])
        let rows = PairingCardPresentation.accessRows(for: card)
        #expect(rows.first?.isElevated == true)
        #expect(rows.first?.text == "Can run system commands")
        #expect(rows.map(\.text).contains("Screen capture"))
        #expect(rows.map(\.text).contains("Camera"))

        // system.which alone is admin-scope (NODE_SYSTEM_RUN_COMMANDS).
        let whichOnly = self.nodeCard(commands: ["system.which"])
        #expect(PairingCardPresentation.accessRows(for: whichOnly).first?.isElevated == true)

        // Non-system commands are still part of the approved surface and
        // must render rather than being granted invisibly.
        let notifyOnly = self.nodeCard(commands: ["system.notify", "contacts.search"])
        let notifyRows = PairingCardPresentation.accessRows(for: notifyOnly)
        #expect(notifyRows.allSatisfy { !$0.isElevated })
        #expect(notifyRows.map(\.text).contains("Commands: system.notify, contacts.search"))
    }

    @Test func `every requested access row renders and admin can not hide`() {
        // No cap: hiding a row could conceal what approval grants.
        let caps = (1...12).map { "cap-\($0)" }
        #expect(PairingCardPresentation.accessRows(for: self.nodeCard(caps: caps)).count == caps.count)

        // operator.admin buried behind ordinary scopes surfaces first, elevated.
        let sneaky = self.deviceCard(scopes: [
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.pairing",
            "operator.talk.secrets",
            "operator.admin",
        ])
        let rows = PairingCardPresentation.accessRows(for: sneaky)
        #expect(rows.count == 6)
        #expect(rows.first?.text == "Admin access")
        #expect(rows.first?.isElevated == true)
    }

    @Test func `device scopes render friendly names`() {
        let card = self.deviceCard(scopes: [
            "operator.admin",
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.pairing",
        ])
        #expect(PairingCardPresentation.accessRows(for: card).map(\.text) == [
            "Admin access",
            "Read OpenClaw data",
            "Send messages and make changes",
            "Manage approvals",
            "Pair and repair devices",
        ])
        #expect(PairingCardPresentation.title(for: card) == "OpenClaw Mac app")
        #expect(PairingCardPresentation.subtitle(for: card) == "Mac (Intel) · Operator")
    }

    @Test func `trust line distinguishes first contact repair and reused ids`() {
        let fresh = self.nodeCard()
        #expect(PairingCardPresentation.trustLine(for: fresh).tone == .neutral)

        // The requester-claimed id is unauthenticated, so an already-paired id
        // must render as a caution (token replacement), never positive trust.
        let reusedId = self.nodeCard(previouslyPaired: true)
        let reusedLine = PairingCardPresentation.trustLine(for: reusedId)
        #expect(reusedLine.tone == .caution)
        #expect(reusedLine.text.contains("already paired"))

        let repair = self.deviceCard(scopes: [], isRepair: true)
        let repairLine = PairingCardPresentation.trustLine(for: repair)
        #expect(repairLine.tone == .caution)
        #expect(repairLine.text.contains("Repair"))

        // Unverified history (stale snapshot) must stay neutral.
        let unknown = self.nodeCard(previouslyPaired: nil)
        let unknownLine = PairingCardPresentation.trustLine(for: unknown)
        #expect(unknownLine.tone == .neutral)
        #expect(!unknownLine.text.contains("already paired"))
    }

    @Test func `identifier shortening keeps head and tail`() {
        let long = "4a865684dbfa7b7937bd333813476ca88b672c2d02ad08fc52b80d88af4e82bd"
        #expect(PairingCardPresentation.shortIdentifier(long) == "4a865684...f4e82bd")
        #expect(PairingCardPresentation.shortIdentifier("short-id") == "short-id")
    }

    @Test func `panel auto presents only for unseen requests`() {
        #expect(!PairingApprovalCenter.shouldAutoPresent(cardIds: [], snoozedIds: []))
        #expect(PairingApprovalCenter.shouldAutoPresent(cardIds: ["a"], snoozedIds: []))
        // Everything on screen was snoozed: stay hidden.
        #expect(!PairingApprovalCenter.shouldAutoPresent(cardIds: ["a"], snoozedIds: ["a"]))
        // A request the user has not seen yet reopens the panel.
        #expect(PairingApprovalCenter.shouldAutoPresent(cardIds: ["a", "b"], snoozedIds: ["a"]))
    }
}

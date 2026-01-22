import AppKit
import ClawdbotIPC
import ClawdbotKit
import Foundation

actor MacNodeRuntime {
    private let cameraCapture = CameraCaptureService()
    private let makeMainActorServices: () async -> any MacNodeRuntimeMainActorServices
    private var cachedMainActorServices: (any MacNodeRuntimeMainActorServices)?
    private var mainSessionKey: String = "main"
    private var eventSender: (@Sendable (String, String?) async -> Void)?

    init(
        makeMainActorServices: @escaping () async -> any MacNodeRuntimeMainActorServices = {
            await MainActor.run { LiveMacNodeRuntimeMainActorServices() }
        })
    {
        self.makeMainActorServices = makeMainActorServices
    }

    func updateMainSessionKey(_ sessionKey: String) {
        let trimmed = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.mainSessionKey = trimmed
    }

    func setEventSender(_ sender: (@Sendable (String, String?) async -> Void)?) {
        self.eventSender = sender
    }

    func handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        let command = req.command
        if self.isCanvasCommand(command), !Self.canvasEnabled() {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdbotNodeError(
                    code: .unavailable,
                    message: "CANVAS_DISABLED: enable Canvas in Settings"))
        }
        do {
            switch command {
            case ClawdbotCanvasCommand.present.rawValue,
                 ClawdbotCanvasCommand.hide.rawValue,
                 ClawdbotCanvasCommand.navigate.rawValue,
                 ClawdbotCanvasCommand.evalJS.rawValue,
                 ClawdbotCanvasCommand.snapshot.rawValue:
                return try await self.handleCanvasInvoke(req)
            case ClawdbotCanvasA2UICommand.reset.rawValue,
                 ClawdbotCanvasA2UICommand.push.rawValue,
                 ClawdbotCanvasA2UICommand.pushJSONL.rawValue:
                return try await self.handleA2UIInvoke(req)
            case ClawdbotCameraCommand.snap.rawValue,
                 ClawdbotCameraCommand.clip.rawValue,
                 ClawdbotCameraCommand.list.rawValue:
                return try await self.handleCameraInvoke(req)
            case ClawdbotLocationCommand.get.rawValue:
                return try await self.handleLocationInvoke(req)
            case MacNodeScreenCommand.record.rawValue:
                return try await self.handleScreenRecordInvoke(req)
            case ClawdbotSystemCommand.run.rawValue:
                return try await self.handleSystemRun(req)
            case ClawdbotSystemCommand.which.rawValue:
                return try await self.handleSystemWhich(req)
            case ClawdbotSystemCommand.notify.rawValue:
                return try await self.handleSystemNotify(req)
            case ClawdbotSystemCommand.execApprovalsGet.rawValue:
                return try await self.handleSystemExecApprovalsGet(req)
            case ClawdbotSystemCommand.execApprovalsSet.rawValue:
                return try await self.handleSystemExecApprovalsSet(req)
            default:
                return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: unknown command")
            }
        } catch {
            return Self.errorResponse(req, code: .unavailable, message: error.localizedDescription)
        }
    }

    private func isCanvasCommand(_ command: String) -> Bool {
        command.hasPrefix("canvas.") || command.hasPrefix("canvas.a2ui.")
    }

    private func handleCanvasInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case ClawdbotCanvasCommand.present.rawValue:
            let params = (try? Self.decodeParams(ClawdbotCanvasPresentParams.self, from: req.paramsJSON)) ??
                ClawdbotCanvasPresentParams()
            let urlTrimmed = params.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let url = urlTrimmed.isEmpty ? nil : urlTrimmed
            let placement = params.placement.map {
                CanvasPlacement(x: $0.x, y: $0.y, width: $0.width, height: $0.height)
            }
            let sessionKey = self.mainSessionKey
            try await MainActor.run {
                _ = try CanvasManager.shared.showDetailed(
                    sessionKey: sessionKey,
                    target: url,
                    placement: placement)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case ClawdbotCanvasCommand.hide.rawValue:
            let sessionKey = self.mainSessionKey
            await MainActor.run {
                CanvasManager.shared.hide(sessionKey: sessionKey)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case ClawdbotCanvasCommand.navigate.rawValue:
            let params = try Self.decodeParams(ClawdbotCanvasNavigateParams.self, from: req.paramsJSON)
            let sessionKey = self.mainSessionKey
            try await MainActor.run {
                _ = try CanvasManager.shared.show(sessionKey: sessionKey, path: params.url)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case ClawdbotCanvasCommand.evalJS.rawValue:
            let params = try Self.decodeParams(ClawdbotCanvasEvalParams.self, from: req.paramsJSON)
            let sessionKey = self.mainSessionKey
            let result = try await CanvasManager.shared.eval(
                sessionKey: sessionKey,
                javaScript: params.javaScript)
            let payload = try Self.encodePayload(["result": result] as [String: String])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case ClawdbotCanvasCommand.snapshot.rawValue:
            let params = try? Self.decodeParams(ClawdbotCanvasSnapshotParams.self, from: req.paramsJSON)
            let format = params?.format ?? .jpeg
            let maxWidth: Int? = {
                if let raw = params?.maxWidth, raw > 0 { return raw }
                return switch format {
                case .png: 900
                case .jpeg: 1600
                }
            }()
            let quality = params?.quality ?? 0.9

            let sessionKey = self.mainSessionKey
            let path = try await CanvasManager.shared.snapshot(sessionKey: sessionKey, outPath: nil)
            defer { try? FileManager().removeItem(atPath: path) }
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            guard let image = NSImage(data: data) else {
                return Self.errorResponse(req, code: .unavailable, message: "canvas snapshot decode failed")
            }
            let encoded = try Self.encodeCanvasSnapshot(
                image: image,
                format: format,
                maxWidth: maxWidth,
                quality: quality)
            let payload = try Self.encodePayload([
                "format": format == .jpeg ? "jpeg" : "png",
                "base64": encoded.base64EncodedString(),
            ])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        default:
            return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: unknown command")
        }
    }

    private func handleA2UIInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case ClawdbotCanvasA2UICommand.reset.rawValue:
            try await self.handleA2UIReset(req)
        case ClawdbotCanvasA2UICommand.push.rawValue,
             ClawdbotCanvasA2UICommand.pushJSONL.rawValue:
            try await self.handleA2UIPush(req)
        default:
            Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: unknown command")
        }
    }

    private func handleCameraInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        guard Self.cameraEnabled() else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdbotNodeError(
                    code: .unavailable,
                    message: "CAMERA_DISABLED: enable Camera in Settings"))
        }
        switch req.command {
        case ClawdbotCameraCommand.snap.rawValue:
            let params = (try? Self.decodeParams(ClawdbotCameraSnapParams.self, from: req.paramsJSON)) ??
                ClawdbotCameraSnapParams()
            let delayMs = min(10000, max(0, params.delayMs ?? 2000))
            let res = try await self.cameraCapture.snap(
                facing: CameraFacing(rawValue: params.facing?.rawValue ?? "") ?? .front,
                maxWidth: params.maxWidth,
                quality: params.quality,
                deviceId: params.deviceId,
                delayMs: delayMs)
            struct SnapPayload: Encodable {
                var format: String
                var base64: String
                var width: Int
                var height: Int
            }
            let payload = try Self.encodePayload(SnapPayload(
                format: (params.format ?? .jpg).rawValue,
                base64: res.data.base64EncodedString(),
                width: Int(res.size.width),
                height: Int(res.size.height)))
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case ClawdbotCameraCommand.clip.rawValue:
            let params = (try? Self.decodeParams(ClawdbotCameraClipParams.self, from: req.paramsJSON)) ??
                ClawdbotCameraClipParams()
            let res = try await self.cameraCapture.clip(
                facing: CameraFacing(rawValue: params.facing?.rawValue ?? "") ?? .front,
                durationMs: params.durationMs,
                includeAudio: params.includeAudio ?? true,
                deviceId: params.deviceId,
                outPath: nil)
            defer { try? FileManager().removeItem(atPath: res.path) }
            let data = try Data(contentsOf: URL(fileURLWithPath: res.path))
            struct ClipPayload: Encodable {
                var format: String
                var base64: String
                var durationMs: Int
                var hasAudio: Bool
            }
            let payload = try Self.encodePayload(ClipPayload(
                format: (params.format ?? .mp4).rawValue,
                base64: data.base64EncodedString(),
                durationMs: res.durationMs,
                hasAudio: res.hasAudio))
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case ClawdbotCameraCommand.list.rawValue:
            let devices = await self.cameraCapture.listDevices()
            let payload = try Self.encodePayload(["devices": devices])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        default:
            return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: unknown command")
        }
    }

    private func handleLocationInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let mode = Self.locationMode()
        guard mode != .off else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdbotNodeError(
                    code: .unavailable,
                    message: "LOCATION_DISABLED: enable Location in Settings"))
        }
        let params = (try? Self.decodeParams(ClawdbotLocationGetParams.self, from: req.paramsJSON)) ??
            ClawdbotLocationGetParams()
        let desired = params.desiredAccuracy ??
            (Self.locationPreciseEnabled() ? .precise : .balanced)
        let services = await self.mainActorServices()
        let status = await services.locationAuthorizationStatus()
        let hasPermission = switch mode {
        case .always:
            status == .authorizedAlways
        case .whileUsing:
            status == .authorizedAlways
        case .off:
            false
        }
        if !hasPermission {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdbotNodeError(
                    code: .unavailable,
                    message: "LOCATION_PERMISSION_REQUIRED: grant Location permission"))
        }
        do {
            let location = try await services.currentLocation(
                desiredAccuracy: desired,
                maxAgeMs: params.maxAgeMs,
                timeoutMs: params.timeoutMs)
            let isPrecise = await services.locationAccuracyAuthorization() == .fullAccuracy
            let payload = ClawdbotLocationPayload(
                lat: location.coordinate.latitude,
                lon: location.coordinate.longitude,
                accuracyMeters: location.horizontalAccuracy,
                altitudeMeters: location.verticalAccuracy >= 0 ? location.altitude : nil,
                speedMps: location.speed >= 0 ? location.speed : nil,
                headingDeg: location.course >= 0 ? location.course : nil,
                timestamp: ISO8601DateFormatter().string(from: location.timestamp),
                isPrecise: isPrecise,
                source: nil)
            let json = try Self.encodePayload(payload)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
        } catch MacNodeLocationService.Error.timeout {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdbotNodeError(
                    code: .unavailable,
                    message: "LOCATION_TIMEOUT: no fix in time"))
        } catch {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: ClawdbotNodeError(
                    code: .unavailable,
                    message: "LOCATION_UNAVAILABLE: \(error.localizedDescription)"))
        }
    }

    private func handleScreenRecordInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = (try? Self.decodeParams(MacNodeScreenRecordParams.self, from: req.paramsJSON)) ??
            MacNodeScreenRecordParams()
        if let format = params.format?.lowercased(), !format.isEmpty, format != "mp4" {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: screen format must be mp4")
        }
        let services = await self.mainActorServices()
        let res = try await services.recordScreen(
            screenIndex: params.screenIndex,
            durationMs: params.durationMs,
            fps: params.fps,
            includeAudio: params.includeAudio,
            outPath: nil)
        defer { try? FileManager().removeItem(atPath: res.path) }
        let data = try Data(contentsOf: URL(fileURLWithPath: res.path))
        struct ScreenPayload: Encodable {
            var format: String
            var base64: String
            var durationMs: Int?
            var fps: Double?
            var screenIndex: Int?
            var hasAudio: Bool
        }
        let payload = try Self.encodePayload(ScreenPayload(
            format: "mp4",
            base64: data.base64EncodedString(),
            durationMs: params.durationMs,
            fps: params.fps,
            screenIndex: params.screenIndex,
            hasAudio: res.hasAudio))
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    private func mainActorServices() async -> any MacNodeRuntimeMainActorServices {
        if let cachedMainActorServices { return cachedMainActorServices }
        let services = await self.makeMainActorServices()
        self.cachedMainActorServices = services
        return services
    }

    private func handleA2UIReset(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        try await self.ensureA2UIHost()

        let sessionKey = self.mainSessionKey
        let json = try await CanvasManager.shared.eval(sessionKey: sessionKey, javaScript: """
        (() => {
          if (!globalThis.clawdbotA2UI) return JSON.stringify({ ok: false, error: "missing clawdbotA2UI" });
          return JSON.stringify(globalThis.clawdbotA2UI.reset());
        })()
        """)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleA2UIPush(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let command = req.command
        let messages: [ClawdbotKit.AnyCodable]
        if command == ClawdbotCanvasA2UICommand.pushJSONL.rawValue {
            let params = try Self.decodeParams(ClawdbotCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
            messages = try ClawdbotCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
        } else {
            do {
                let params = try Self.decodeParams(ClawdbotCanvasA2UIPushParams.self, from: req.paramsJSON)
                messages = params.messages
            } catch {
                let params = try Self.decodeParams(ClawdbotCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                messages = try ClawdbotCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
            }
        }

        try await self.ensureA2UIHost()

        let messagesJSON = try ClawdbotCanvasA2UIJSONL.encodeMessagesJSONArray(messages)
        let js = """
        (() => {
          try {
            if (!globalThis.clawdbotA2UI) return JSON.stringify({ ok: false, error: "missing clawdbotA2UI" });
            const messages = \(messagesJSON);
            return JSON.stringify(globalThis.clawdbotA2UI.applyMessages(messages));
          } catch (e) {
            return JSON.stringify({ ok: false, error: String(e?.message ?? e) });
          }
        })()
        """
        let sessionKey = self.mainSessionKey
        let resultJSON = try await CanvasManager.shared.eval(sessionKey: sessionKey, javaScript: js)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: resultJSON)
    }

    private func ensureA2UIHost() async throws {
        if await self.isA2UIReady() { return }
        guard let a2uiUrl = await self.resolveA2UIHostUrl() else {
            throw NSError(domain: "Canvas", code: 30, userInfo: [
                NSLocalizedDescriptionKey: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
            ])
        }
        let sessionKey = self.mainSessionKey
        _ = try await MainActor.run {
            try CanvasManager.shared.show(sessionKey: sessionKey, path: a2uiUrl)
        }
        if await self.isA2UIReady(poll: true) { return }
        throw NSError(domain: "Canvas", code: 31, userInfo: [
            NSLocalizedDescriptionKey: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable",
        ])
    }

    private func resolveA2UIHostUrl() async -> String? {
        guard let raw = await GatewayConnection.shared.canvasHostUrl() else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let baseUrl = URL(string: trimmed) else { return nil }
        return baseUrl.appendingPathComponent("__clawdbot__/a2ui/").absoluteString + "?platform=macos"
    }

    private func isA2UIReady(poll: Bool = false) async -> Bool {
        let deadline = poll ? Date().addingTimeInterval(6.0) : Date()
        while true {
            do {
                let sessionKey = self.mainSessionKey
                let ready = try await CanvasManager.shared.eval(sessionKey: sessionKey, javaScript: """
                (() => String(Boolean(globalThis.clawdbotA2UI)))()
                """)
                let trimmed = ready.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed == "true" { return true }
            } catch {
                // Ignore transient eval failures while the page is loading.
            }

            guard poll, Date() < deadline else { return false }
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
    }

    private func handleSystemRun(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(ClawdbotSystemRunParams.self, from: req.paramsJSON)
        let command = params.command
        guard !command.isEmpty else {
            return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: command required")
        }
        let displayCommand = ExecCommandFormatter.displayString(for: command, rawCommand: params.rawCommand)

        let trimmedAgent = params.agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let agentId = trimmedAgent.isEmpty ? nil : trimmedAgent
        let approvals = ExecApprovalsStore.resolve(agentId: agentId)
        let security = approvals.agent.security
        let ask = approvals.agent.ask
        let autoAllowSkills = approvals.agent.autoAllowSkills
        let sessionKey = (params.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? params.sessionKey!.trimmingCharacters(in: .whitespacesAndNewlines)
            : self.mainSessionKey
        let runId = UUID().uuidString
        let env = Self.sanitizedEnv(params.env)
        let resolution = ExecCommandResolution.resolve(
            command: command,
            rawCommand: params.rawCommand,
            cwd: params.cwd,
            env: env)
        let allowlistMatch = security == .allowlist
            ? ExecAllowlistMatcher.match(entries: approvals.allowlist, resolution: resolution)
            : nil
        let skillAllow: Bool
        if autoAllowSkills, let name = resolution?.executableName {
            let bins = await SkillBinsCache.shared.currentBins()
            skillAllow = bins.contains(name)
        } else {
            skillAllow = false
        }

        if security == .deny {
            await self.emitExecEvent(
                "exec.denied",
                payload: ExecEventPayload(
                    sessionKey: sessionKey,
                    runId: runId,
                    host: "node",
                    command: displayCommand,
                    reason: "security=deny"))
            return Self.errorResponse(
                req,
                code: .unavailable,
                message: "SYSTEM_RUN_DISABLED: security=deny")
        }

        let approval = await self.resolveSystemRunApproval(
            req: req,
            params: params,
            context: ExecRunContext(
                displayCommand: displayCommand,
                security: security,
                ask: ask,
                agentId: agentId,
                resolution: resolution,
                allowlistMatch: allowlistMatch,
                skillAllow: skillAllow,
                sessionKey: sessionKey,
                runId: runId))
        if let response = approval.response { return response }
        let approvedByAsk = approval.approvedByAsk
        let persistAllowlist = approval.persistAllowlist
        if persistAllowlist, security == .allowlist,
           let pattern = ExecApprovalHelpers.allowlistPattern(command: command, resolution: resolution)
        {
            ExecApprovalsStore.addAllowlistEntry(agentId: agentId, pattern: pattern)
        }

        if security == .allowlist, allowlistMatch == nil, !skillAllow, !approvedByAsk {
            await self.emitExecEvent(
                "exec.denied",
                payload: ExecEventPayload(
                    sessionKey: sessionKey,
                    runId: runId,
                    host: "node",
                    command: displayCommand,
                    reason: "allowlist-miss"))
            return Self.errorResponse(
                req,
                code: .unavailable,
                message: "SYSTEM_RUN_DENIED: allowlist miss")
        }

        if let match = allowlistMatch {
            ExecApprovalsStore.recordAllowlistUse(
                agentId: agentId,
                pattern: match.pattern,
                command: displayCommand,
                resolvedPath: resolution?.resolvedPath)
        }

        if params.needsScreenRecording == true {
            let authorized = await PermissionManager
                .status([.screenRecording])[.screenRecording] ?? false
            if !authorized {
                await self.emitExecEvent(
                    "exec.denied",
                    payload: ExecEventPayload(
                        sessionKey: sessionKey,
                        runId: runId,
                        host: "node",
                        command: displayCommand,
                        reason: "permission:screenRecording"))
                return Self.errorResponse(
                    req,
                    code: .unavailable,
                    message: "PERMISSION_MISSING: screenRecording")
            }
        }

        let timeoutSec = params.timeoutMs.flatMap { Double($0) / 1000.0 }
        await self.emitExecEvent(
            "exec.started",
            payload: ExecEventPayload(
                sessionKey: sessionKey,
                runId: runId,
                host: "node",
                command: displayCommand))
        let result = await ShellExecutor.runDetailed(
            command: command,
            cwd: params.cwd,
            env: env,
            timeout: timeoutSec)
        let combined = [result.stdout, result.stderr, result.errorMessage]
            .compactMap(\.self)
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        await self.emitExecEvent(
            "exec.finished",
            payload: ExecEventPayload(
                sessionKey: sessionKey,
                runId: runId,
                host: "node",
                command: displayCommand,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                success: result.success,
                output: ExecEventPayload.truncateOutput(combined)))

        struct RunPayload: Encodable {
            var exitCode: Int?
            var timedOut: Bool
            var success: Bool
            var stdout: String
            var stderr: String
            var error: String?
        }

        let payload = try Self.encodePayload(RunPayload(
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            success: result.success,
            stdout: result.stdout,
            stderr: result.stderr,
            error: result.errorMessage))
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    private func handleSystemWhich(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(ClawdbotSystemWhichParams.self, from: req.paramsJSON)
        let bins = params.bins
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !bins.isEmpty else {
            return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: bins required")
        }

        let searchPaths = CommandResolver.preferredPaths()
        var matches: [String] = []
        var paths: [String: String] = [:]
        for bin in bins {
            if let path = CommandResolver.findExecutable(named: bin, searchPaths: searchPaths) {
                matches.append(bin)
                paths[bin] = path
            }
        }

        struct WhichPayload: Encodable {
            let bins: [String]
            let paths: [String: String]
        }
        let payload = try Self.encodePayload(WhichPayload(bins: matches, paths: paths))
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    private struct ExecApprovalOutcome {
        var approvedByAsk: Bool
        var persistAllowlist: Bool
        var response: BridgeInvokeResponse?
    }

    private struct ExecRunContext {
        var displayCommand: String
        var security: ExecSecurity
        var ask: ExecAsk
        var agentId: String?
        var resolution: ExecCommandResolution?
        var allowlistMatch: ExecAllowlistEntry?
        var skillAllow: Bool
        var sessionKey: String
        var runId: String
    }

    private func resolveSystemRunApproval(
        req: BridgeInvokeRequest,
        params: ClawdbotSystemRunParams,
        context: ExecRunContext) async -> ExecApprovalOutcome
    {
        let requiresAsk = ExecApprovalHelpers.requiresAsk(
            ask: context.ask,
            security: context.security,
            allowlistMatch: context.allowlistMatch,
            skillAllow: context.skillAllow)

        let decisionFromParams = ExecApprovalHelpers.parseDecision(params.approvalDecision)
        var approvedByAsk = params.approved == true || decisionFromParams != nil
        var persistAllowlist = decisionFromParams == .allowAlways
        if decisionFromParams == .deny {
            await self.emitExecEvent(
                "exec.denied",
                payload: ExecEventPayload(
                    sessionKey: context.sessionKey,
                    runId: context.runId,
                    host: "node",
                    command: context.displayCommand,
                    reason: "user-denied"))
            return ExecApprovalOutcome(
                approvedByAsk: approvedByAsk,
                persistAllowlist: persistAllowlist,
                response: Self.errorResponse(
                    req,
                    code: .unavailable,
                    message: "SYSTEM_RUN_DENIED: user denied"))
        }

        if requiresAsk, !approvedByAsk {
            let decision = await MainActor.run {
                ExecApprovalsPromptPresenter.prompt(
                    ExecApprovalPromptRequest(
                        command: context.displayCommand,
                        cwd: params.cwd,
                        host: "node",
                        security: context.security.rawValue,
                        ask: context.ask.rawValue,
                        agentId: context.agentId,
                        resolvedPath: context.resolution?.resolvedPath,
                        sessionKey: context.sessionKey))
            }
            switch decision {
            case .deny:
                await self.emitExecEvent(
                    "exec.denied",
                    payload: ExecEventPayload(
                        sessionKey: context.sessionKey,
                        runId: context.runId,
                        host: "node",
                        command: context.displayCommand,
                        reason: "user-denied"))
                return ExecApprovalOutcome(
                    approvedByAsk: approvedByAsk,
                    persistAllowlist: persistAllowlist,
                    response: Self.errorResponse(
                        req,
                        code: .unavailable,
                        message: "SYSTEM_RUN_DENIED: user denied"))
            case .allowAlways:
                approvedByAsk = true
                persistAllowlist = true
            case .allowOnce:
                approvedByAsk = true
            }
        }

        return ExecApprovalOutcome(
            approvedByAsk: approvedByAsk,
            persistAllowlist: persistAllowlist,
            response: nil)
    }

    private func handleSystemExecApprovalsGet(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        _ = ExecApprovalsStore.ensureFile()
        let snapshot = ExecApprovalsStore.readSnapshot()
        let redacted = ExecApprovalsSnapshot(
            path: snapshot.path,
            exists: snapshot.exists,
            hash: snapshot.hash,
            file: ExecApprovalsStore.redactForSnapshot(snapshot.file))
        let payload = try Self.encodePayload(redacted)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    private func handleSystemExecApprovalsSet(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        struct SetParams: Decodable {
            var file: ExecApprovalsFile
            var baseHash: String?
        }

        let params = try Self.decodeParams(SetParams.self, from: req.paramsJSON)
        let current = ExecApprovalsStore.ensureFile()
        let snapshot = ExecApprovalsStore.readSnapshot()
        if snapshot.exists {
            if snapshot.hash.isEmpty {
                return Self.errorResponse(
                    req,
                    code: .invalidRequest,
                    message: "INVALID_REQUEST: exec approvals base hash unavailable; reload and retry")
            }
            let baseHash = params.baseHash?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if baseHash.isEmpty {
                return Self.errorResponse(
                    req,
                    code: .invalidRequest,
                    message: "INVALID_REQUEST: exec approvals base hash required; reload and retry")
            }
            if baseHash != snapshot.hash {
                return Self.errorResponse(
                    req,
                    code: .invalidRequest,
                    message: "INVALID_REQUEST: exec approvals changed; reload and retry")
            }
        }

        var normalized = ExecApprovalsStore.normalizeIncoming(params.file)
        let socketPath = normalized.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = normalized.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedPath = (socketPath?.isEmpty == false)
            ? socketPath!
            : current.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines) ??
            ExecApprovalsStore.socketPath()
        let resolvedToken = (token?.isEmpty == false)
            ? token!
            : current.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        normalized.socket = ExecApprovalsSocketConfig(path: resolvedPath, token: resolvedToken)

        ExecApprovalsStore.saveFile(normalized)
        let nextSnapshot = ExecApprovalsStore.readSnapshot()
        let redacted = ExecApprovalsSnapshot(
            path: nextSnapshot.path,
            exists: nextSnapshot.exists,
            hash: nextSnapshot.hash,
            file: ExecApprovalsStore.redactForSnapshot(nextSnapshot.file))
        let payload = try Self.encodePayload(redacted)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    private func emitExecEvent(_ event: String, payload: ExecEventPayload) async {
        guard let sender = self.eventSender else { return }
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else {
            return
        }
        await sender(event, json)
    }

    private func handleSystemNotify(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(ClawdbotSystemNotifyParams.self, from: req.paramsJSON)
        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = params.body.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty, body.isEmpty {
            return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: empty notification")
        }

        let priority = params.priority.flatMap { NotificationPriority(rawValue: $0.rawValue) }
        let delivery = params.delivery.flatMap { NotificationDelivery(rawValue: $0.rawValue) } ?? .system
        let manager = NotificationManager()

        switch delivery {
        case .system:
            let ok = await manager.send(
                title: title,
                body: body,
                sound: params.sound,
                priority: priority)
            return ok
                ? BridgeInvokeResponse(id: req.id, ok: true)
                : Self.errorResponse(req, code: .unavailable, message: "NOT_AUTHORIZED: notifications")
        case .overlay:
            await NotifyOverlayController.shared.present(title: title, body: body)
            return BridgeInvokeResponse(id: req.id, ok: true)
        case .auto:
            let ok = await manager.send(
                title: title,
                body: body,
                sound: params.sound,
                priority: priority)
            if ok {
                return BridgeInvokeResponse(id: req.id, ok: true)
            }
            await NotifyOverlayController.shared.present(title: title, body: body)
            return BridgeInvokeResponse(id: req.id, ok: true)
        }
    }
}

extension MacNodeRuntime {
    private static func decodeParams<T: Decodable>(_ type: T.Type, from json: String?) throws -> T {
        guard let json, let data = json.data(using: .utf8) else {
            throw NSError(domain: "Gateway", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "INVALID_REQUEST: paramsJSON required",
            ])
        }
        return try JSONDecoder().decode(type, from: data)
    }

    private static func encodePayload(_ obj: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(obj)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw NSError(domain: "Node", code: 21, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode payload as UTF-8",
            ])
        }
        return json
    }

    private nonisolated static func canvasEnabled() -> Bool {
        UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
    }

    private nonisolated static func cameraEnabled() -> Bool {
        UserDefaults.standard.object(forKey: cameraEnabledKey) as? Bool ?? false
    }

    private static let blockedEnvKeys: Set<String> = [
        "PATH",
        "NODE_OPTIONS",
        "PYTHONHOME",
        "PYTHONPATH",
        "PERL5LIB",
        "PERL5OPT",
        "RUBYOPT",
    ]

    private static let blockedEnvPrefixes: [String] = [
        "DYLD_",
        "LD_",
    ]

    private static func sanitizedEnv(_ overrides: [String: String]?) -> [String: String]? {
        guard let overrides else { return nil }
        var merged = ProcessInfo.processInfo.environment
        for (rawKey, value) in overrides {
            let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { continue }
            let upper = key.uppercased()
            if self.blockedEnvKeys.contains(upper) { continue }
            if self.blockedEnvPrefixes.contains(where: { upper.hasPrefix($0) }) { continue }
            merged[key] = value
        }
        return merged
    }

    private nonisolated static func locationMode() -> ClawdbotLocationMode {
        let raw = UserDefaults.standard.string(forKey: locationModeKey) ?? "off"
        return ClawdbotLocationMode(rawValue: raw) ?? .off
    }

    private nonisolated static func locationPreciseEnabled() -> Bool {
        if UserDefaults.standard.object(forKey: locationPreciseKey) == nil { return true }
        return UserDefaults.standard.bool(forKey: locationPreciseKey)
    }

    private static func errorResponse(
        _ req: BridgeInvokeRequest,
        code: ClawdbotNodeErrorCode,
        message: String) -> BridgeInvokeResponse
    {
        BridgeInvokeResponse(
            id: req.id,
            ok: false,
            error: ClawdbotNodeError(code: code, message: message))
    }

    private static func encodeCanvasSnapshot(
        image: NSImage,
        format: ClawdbotCanvasSnapshotFormat,
        maxWidth: Int?,
        quality: Double) throws -> Data
    {
        let source = Self.scaleImage(image, maxWidth: maxWidth) ?? image
        guard let tiff = source.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff)
        else {
            throw NSError(domain: "Canvas", code: 22, userInfo: [
                NSLocalizedDescriptionKey: "snapshot encode failed",
            ])
        }

        switch format {
        case .png:
            guard let data = rep.representation(using: .png, properties: [:]) else {
                throw NSError(domain: "Canvas", code: 23, userInfo: [
                    NSLocalizedDescriptionKey: "png encode failed",
                ])
            }
            return data
        case .jpeg:
            let clamped = min(1.0, max(0.05, quality))
            guard let data = rep.representation(
                using: .jpeg,
                properties: [.compressionFactor: clamped])
            else {
                throw NSError(domain: "Canvas", code: 24, userInfo: [
                    NSLocalizedDescriptionKey: "jpeg encode failed",
                ])
            }
            return data
        }
    }

    private static func scaleImage(_ image: NSImage, maxWidth: Int?) -> NSImage? {
        guard let maxWidth, maxWidth > 0 else { return image }
        let size = image.size
        guard size.width > 0, size.width > CGFloat(maxWidth) else { return image }
        let scale = CGFloat(maxWidth) / size.width
        let target = NSSize(width: CGFloat(maxWidth), height: size.height * scale)

        let out = NSImage(size: target)
        out.lockFocus()
        image.draw(
            in: NSRect(origin: .zero, size: target),
            from: NSRect(origin: .zero, size: size),
            operation: .copy,
            fraction: 1.0)
        out.unlockFocus()
        return out
    }
}

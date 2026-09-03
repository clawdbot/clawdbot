import Foundation
import OpenClawIPC
import OpenClawKit

actor MacNodeClaudeSessionCatalogWorker {
    typealias Operation = @Sendable (String?) throws -> String

    private struct PendingOperation {
        var id: UUID
        var paramsJSON: String?
        var operation: Operation
        var continuation: CheckedContinuation<String, Error>
    }

    private struct ActiveOperation {
        var id: UUID
        var task: Task<String, Error>
        var continuation: CheckedContinuation<String, Error>?
    }

    static let shared = MacNodeClaudeSessionCatalogWorker(
        listOperation: { try MacNodeClaudeSessionCatalog.list(paramsJSON: $0) },
        readOperation: { try MacNodeClaudeSessionCatalog.read(paramsJSON: $0) })

    private let listOperation: Operation
    private let readOperation: Operation
    private var pending: [PendingOperation] = []
    private var active: ActiveOperation?

    init(
        listOperation: @escaping Operation,
        readOperation: @escaping Operation)
    {
        self.listOperation = listOperation
        self.readOperation = readOperation
    }

    func list(paramsJSON: String?) async throws -> String {
        try await self.enqueue(paramsJSON: paramsJSON, operation: self.listOperation)
    }

    func read(paramsJSON: String?) async throws -> String {
        try await self.enqueue(paramsJSON: paramsJSON, operation: self.readOperation)
    }

    private func enqueue(
        paramsJSON: String?,
        operation: @escaping Operation) async throws -> String
    {
        let id = UUID()
        let result: String = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.pending.append(PendingOperation(
                    id: id,
                    paramsJSON: paramsJSON,
                    operation: operation,
                    continuation: continuation))
                self.startNextIfNeeded()
            }
        } onCancel: {
            Task { await self.cancel(id: id) }
        }
        try Task.checkCancellation()
        return result
    }

    private func startNextIfNeeded() {
        guard self.active == nil, !self.pending.isEmpty else { return }
        let pending = self.pending.removeFirst()
        let task = Task.detached(priority: .utility) {
            try Task.checkCancellation()
            return try pending.operation(pending.paramsJSON)
        }
        self.active = ActiveOperation(
            id: pending.id,
            task: task,
            continuation: pending.continuation)
        // One Claude filesystem operation at a time. Codex and other node commands
        // remain free to run while this dedicated lane waits or scans.
        Task {
            let result = await task.result
            self.finish(id: pending.id, result: result)
        }
    }

    private func cancel(id: UUID) {
        if let index = pending.firstIndex(where: { $0.id == id }) {
            let pending = self.pending.remove(at: index)
            pending.continuation.resume(throwing: CancellationError())
            return
        }
        guard self.active?.id == id else { return }
        self.active?.continuation?.resume(throwing: CancellationError())
        self.active?.continuation = nil
        self.active?.task.cancel()
    }

    private func finish(id: UUID, result: Result<String, Error>) {
        guard self.active?.id == id else { return }
        let continuation = self.active?.continuation
        self.active = nil
        continuation?.resume(with: result)
        self.startNextIfNeeded()
    }
}

actor MacNodeRuntime {
    private static let maxGatewayPayloadBytes = 25 * 1024 * 1024
    private static let maxScreenSnapshotRawBytesBeforeBase64 = (maxGatewayPayloadBytes / 4) * 3
    private static let cuaOwnedCommands = Set([
        MacNodeScreenCommand.snapshot.rawValue,
        OpenClawComputerCommand.act.rawValue,
    ])
    private let cameraCapture = CameraCaptureService()
    private let cameraPTZ: any CameraPTZServicing
    private let nodeHostWorker: (any MacNodeHostWorking)?
    private let makeMainActorServices: @Sendable () async -> any MacNodeRuntimeMainActorServices
    // Injectable so tests pin the gate instead of racing on process-global UserDefaults.
    private let computerControlEnabled: @Sendable () -> Bool
    private let computerControlProvider: @Sendable () -> ComputerControlProvider
    private let canvasHostedSurfaceResolver: MacNodeCanvasHostedSurfaceResolver
    private let codexThreadCatalogEnabled: @Sendable () -> Bool
    private let codexThreadCatalogClient: MacNodeCodexThreadCatalogClient
    private let codexThreadListRequest: (@Sendable (String?) async throws -> String)?
    private let codexThreadTurnsRequest: (@Sendable (String?) async throws -> String)?
    private let claudeSessionCatalogEnabled: @Sendable () -> Bool
    private let claudeSessionListRequest: @Sendable (String?) async throws -> String
    private let claudeSessionReadRequest: @Sendable (String?) async throws -> String
    private var cachedMainActorServices: (any MacNodeRuntimeMainActorServices)?
    /// Single-flight lazy initialization. Separate service instances would split
    /// ownership of held computer input and make lifecycle release incomplete.
    private var mainActorServicesInitializationTask: Task<any MacNodeRuntimeMainActorServices, Never>?
    /// Invalidates computer actions admitted before a lifecycle release, including
    /// the first action while the shared main-actor services are still initializing.
    private var computerInputReleaseGeneration: UInt64 = 0
    private var mainSessionKey: String = "main"

    init(
        nodeHostWorker: (any MacNodeHostWorking)? = nil,
        cameraPTZ: any CameraPTZServicing = CameraPTZService(),
        makeMainActorServices: @escaping @Sendable () async -> any MacNodeRuntimeMainActorServices = {
            await MainActor.run { LiveMacNodeRuntimeMainActorServices() }
        },
        computerControlEnabled: @escaping @Sendable () -> Bool = {
            MacNodeRuntime.computerControlEnabledDefault()
        },
        computerControlProvider: @escaping @Sendable () -> ComputerControlProvider = {
            ComputerControlProvider.current()
        },
        canvasSurfaceUrl: @escaping @Sendable () async -> String? = {
            await GatewayConnection.shared.canvasPluginSurfaceUrl()
        },
        refreshCanvasSurfaceUrl: @escaping @Sendable (String?) async -> String? = { _ in nil },
        codexThreadCatalogEnabled: @escaping @Sendable () -> Bool = {
            MacNodeCodexThreadCatalog.shouldAdvertise()
        },
        codexThreadCatalogClient: MacNodeCodexThreadCatalogClient = MacNodeCodexThreadCatalogClient(),
        codexThreadListRequest: (@Sendable (String?) async throws -> String)? = nil,
        codexThreadTurnsRequest: (@Sendable (String?) async throws -> String)? = nil,
        claudeSessionCatalogEnabled: @escaping @Sendable () -> Bool = {
            MacNodeClaudeSessionCatalog.shouldAdvertise()
        },
        claudeSessionListRequest: @escaping @Sendable (String?) async throws -> String = { paramsJSON in
            try await MacNodeClaudeSessionCatalogWorker.shared.list(paramsJSON: paramsJSON)
        },
        claudeSessionReadRequest: @escaping @Sendable (String?) async throws -> String = { paramsJSON in
            try await MacNodeClaudeSessionCatalogWorker.shared.read(paramsJSON: paramsJSON)
        })
    {
        self.nodeHostWorker = nodeHostWorker
        self.cameraPTZ = cameraPTZ
        self.makeMainActorServices = makeMainActorServices
        self.computerControlEnabled = computerControlEnabled
        self.computerControlProvider = computerControlProvider
        self.canvasHostedSurfaceResolver = MacNodeCanvasHostedSurfaceResolver(
            currentSurfaceURL: canvasSurfaceUrl,
            refreshSurfaceURL: refreshCanvasSurfaceUrl)
        self.codexThreadCatalogEnabled = codexThreadCatalogEnabled
        self.codexThreadCatalogClient = codexThreadCatalogClient
        self.codexThreadListRequest = codexThreadListRequest
        self.codexThreadTurnsRequest = codexThreadTurnsRequest
        self.claudeSessionCatalogEnabled = claudeSessionCatalogEnabled
        self.claudeSessionListRequest = claudeSessionListRequest
        self.claudeSessionReadRequest = claudeSessionReadRequest
    }

    func updateMainSessionKey(_ sessionKey: String) {
        let trimmed = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.mainSessionKey = trimmed
    }

    /// One branch per advertised native command keeps command ownership explicit.
    func handleInvoke(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        let command = req.command
        if let rejection = Self.canvasCommandRejection(req) {
            return rejection
        }
        if let cuaResponse = await handleCuaInvokeIfSelected(req) {
            return cuaResponse
        }
        do {
            switch command {
            case OpenClawCanvasCommand.present.rawValue,
                 OpenClawCanvasCommand.hide.rawValue,
                 OpenClawCanvasCommand.navigate.rawValue:
                return try await handleCanvasInvoke(req)
            case OpenClawCameraCommand.snap.rawValue,
                 OpenClawCameraCommand.clip.rawValue,
                 OpenClawCameraCommand.list.rawValue,
                 OpenClawCameraCommand.ptzStatus.rawValue,
                 OpenClawCameraCommand.ptzControl.rawValue:
                return try await handleCameraInvoke(req)
            case OpenClawLocationCommand.get.rawValue:
                return try await handleLocationInvoke(req)
            case MacNodeScreenCommand.snapshot.rawValue:
                return try await handleScreenSnapshotInvoke(req)
            case MacNodeScreenCommand.record.rawValue:
                return try await handleScreenRecordInvoke(req)
            case OpenClawComputerCommand.act.rawValue:
                return try await handleComputerActInvoke(req)
            case OpenClawSystemCommand.notify.rawValue:
                return try await handleSystemNotify(req)
            case MacNodeCodexThreadCatalogContract.listCommand,
                 MacNodeCodexThreadCatalogContract.turnsCommand:
                return try await self.handleCodexThreadInvoke(req)
            case MacNodeClaudeSessionCatalogContract.listCommand,
                 MacNodeClaudeSessionCatalogContract.readCommand:
                return try await self.handleClaudeSessionInvoke(req)
            default:
                // Private supervisor controls are not public pairing capabilities.
                // The shared dispatcher owns their validation and local hosting consent.
                if let nodeHostWorker {
                    return await nodeHostWorker.invoke(req)
                }
                return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: unknown command")
            }
        } catch let error as MacNodeCodexThreadCatalog.CatalogError {
            return Self.errorResponse(
                req,
                code: error.isInvalidRequest ? .invalidRequest : .unavailable,
                message: error.localizedDescription)
        } catch let error as MacNodeClaudeSessionCatalog.CatalogError {
            return Self.errorResponse(
                req,
                code: error.isInvalidRequest ? .invalidRequest : .unavailable,
                message: error.localizedDescription)
        } catch let error as CameraPTZError {
            let code: OpenClawNodeErrorCode = switch error {
            case .invalidRequest, .axisUnsupported: .invalidRequest
            case .deviceNotFound, .unsupported, .partial: .unavailable
            }
            return Self.errorResponse(req, code: code, message: error.localizedDescription)
        } catch let error as MacNodeCanvasTargetError {
            return Self.errorResponse(req, code: .invalidRequest, message: error.localizedDescription)
        } catch {
            return Self.errorResponse(req, code: .unavailable, message: error.localizedDescription)
        }
    }

    private static let canvasCommands: Set<String> = [
        OpenClawCanvasCommand.present.rawValue,
        OpenClawCanvasCommand.hide.rawValue,
        OpenClawCanvasCommand.navigate.rawValue,
    ]

    private static func canvasCommandRejection(_ req: BridgeInvokeRequest) -> BridgeInvokeResponse? {
        guard req.command.hasPrefix("canvas.") else { return nil }
        guard self.canvasCommands.contains(req.command) else {
            return self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: unknown command")
        }
        guard self.canvasEnabled() else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "CANVAS_DISABLED: enable Canvas in Settings"))
        }
        return nil
    }

    private func handleCuaInvokeIfSelected(_ req: BridgeInvokeRequest) async -> BridgeInvokeResponse? {
        guard self.computerControlProvider() == .cua,
              Self.cuaOwnedCommands.contains(req.command)
        else { return nil }
        guard self.computerControlEnabled() else {
            return Self.errorResponse(
                req,
                code: .unavailable,
                message: "COMPUTER_DISABLED: enable Computer Control in Settings")
        }
        guard let nodeHostWorker, await nodeHostWorker.supports(req.command) else {
            return Self.errorResponse(
                req,
                code: .unavailable,
                message: "UNAVAILABLE: selected CUA provider is not ready")
        }
        return await nodeHostWorker.invoke(req)
    }

    private func handleCodexThreadInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        // Freeze native ownership before awaiting worker support so one invocation cannot switch owners.
        let nativeCatalogEnabled = self.codexThreadCatalogEnabled()
        if !nativeCatalogEnabled,
           let nodeHostWorker,
           await nodeHostWorker.supports(req.command)
        {
            return await nodeHostWorker.invoke(req)
        }
        guard nativeCatalogEnabled else {
            return Self.errorResponse(
                req,
                code: .unavailable,
                message: "UNAVAILABLE: Codex session catalog is disabled")
        }
        let payload: String = if req.command == MacNodeCodexThreadCatalogContract.listCommand {
            if let request = codexThreadListRequest {
                try await request(req.paramsJSON)
            } else {
                try await self.codexThreadCatalogClient.list(paramsJSON: req.paramsJSON)
            }
        } else {
            if let request = codexThreadTurnsRequest {
                try await request(req.paramsJSON)
            } else {
                try await self.codexThreadCatalogClient.turns(paramsJSON: req.paramsJSON)
            }
        }
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    private func handleClaudeSessionInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        guard self.claudeSessionCatalogEnabled() else {
            return Self.errorResponse(
                req,
                code: .unavailable,
                message: "UNAVAILABLE: Claude session catalog is disabled")
        }
        let request = req.command == MacNodeClaudeSessionCatalogContract.listCommand
            ? self.claudeSessionListRequest
            : self.claudeSessionReadRequest
        let payload = try await request(req.paramsJSON)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }
}

// MARK: - Canvas command handling

extension MacNodeRuntime {
    private func handleCanvasInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        switch req.command {
        case OpenClawCanvasCommand.present.rawValue:
            let params = (try? Self.decodeParams(OpenClawCanvasPresentParams.self, from: req.paramsJSON)) ??
                OpenClawCanvasPresentParams()
            let urlTrimmed = params.url?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let url = urlTrimmed.isEmpty ? nil : urlTrimmed
            let effectiveURL = try await resolveCanvasTarget(url)
            let placement = params.placement.map {
                CanvasPlacement(x: $0.x, y: $0.y, width: $0.width, height: $0.height)
            }
            let sessionKey = self.mainSessionKey
            try await MainActor.run {
                _ = try CanvasManager.shared.showDetailed(
                    sessionKey: sessionKey,
                    target: effectiveURL,
                    placement: placement)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.hide.rawValue:
            let sessionKey = self.mainSessionKey
            await MainActor.run {
                CanvasManager.shared.hide(sessionKey: sessionKey)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.navigate.rawValue:
            let params = try Self.decodeParams(OpenClawCanvasNavigateParams.self, from: req.paramsJSON)
            let effectiveURL = try await resolveCanvasTarget(params.url)
            let sessionKey = self.mainSessionKey
            try await MainActor.run {
                _ = try CanvasManager.shared.show(
                    sessionKey: sessionKey,
                    path: effectiveURL)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        default:
            return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: unknown command")
        }
    }

    private func resolveCanvasTarget(_ rawTarget: String?) async throws -> String? {
        guard let target = rawTarget?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty else {
            return nil
        }
        if CanvasHostedURLResolver.isHostedTarget(target) {
            return try await self.canvasHostedSurfaceResolver.resolveTarget(target)?.absoluteString
        }
        guard CanvasHostedURLResolver.isAppLocalTarget(target) else {
            throw MacNodeCanvasTargetError.invalidTarget
        }
        return target
    }
}

private enum MacNodeCanvasTargetError: LocalizedError {
    case invalidTarget

    var errorDescription: String? {
        "INVALID_REQUEST: canvas target must be a hosted widget-document path or app-local Canvas URL"
    }
}

// MARK: - Device command handling

extension MacNodeRuntime {
    private func handleCameraInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        guard Self.cameraEnabled() else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "CAMERA_DISABLED: enable Camera in Settings"))
        }
        switch req.command {
        case OpenClawCameraCommand.snap.rawValue:
            let params = (try? Self.decodeParams(OpenClawCameraSnapParams.self, from: req.paramsJSON)) ??
                OpenClawCameraSnapParams()
            let delayMs = min(10000, max(0, params.delayMs ?? 2000))
            let res = try await cameraCapture.snap(
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
        case OpenClawCameraCommand.clip.rawValue:
            let params = (try? Self.decodeParams(OpenClawCameraClipParams.self, from: req.paramsJSON)) ??
                OpenClawCameraClipParams()
            let res = try await cameraCapture.clip(
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
        case OpenClawCameraCommand.list.rawValue:
            let devices = await cameraCapture.listDevices()
            let payload = try Self.encodePayload(["devices": devices])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCameraCommand.ptzStatus.rawValue:
            let params: OpenClawCameraPTZStatusParams
            do {
                params = try Self.decodeParams(OpenClawCameraPTZStatusParams.self, from: req.paramsJSON)
            } catch {
                throw CameraPTZError.invalidRequest("invalid camera.ptz.status params")
            }
            let payload = try await Self.encodePayload(self.cameraPTZ.status(deviceId: params.deviceId))
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCameraCommand.ptzControl.rawValue:
            let params: OpenClawCameraPTZControlParams
            do {
                params = try Self.decodeParams(OpenClawCameraPTZControlParams.self, from: req.paramsJSON)
            } catch {
                throw CameraPTZError.invalidRequest("invalid camera.ptz.control params")
            }
            let payload = try await Self.encodePayload(self.cameraPTZ.control(params))
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
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_DISABLED: enable Location in Settings"))
        }
        let params = (try? Self.decodeParams(OpenClawLocationGetParams.self, from: req.paramsJSON)) ??
            OpenClawLocationGetParams()
        let desired = params.desiredAccuracy ??
            (Self.locationPreciseEnabled() ? .precise : .balanced)
        let services = await mainActorServices()
        let status = await services.locationAuthorizationStatus()
        let hasPermission = PermissionManager.isLocationAuthorized(
            status: status,
            requireAlways: mode == .always)
        if !hasPermission {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_PERMISSION_REQUIRED: grant Location permission"))
        }
        do {
            let location = try await services.currentLocation(
                desiredAccuracy: desired,
                maxAgeMs: params.maxAgeMs,
                timeoutMs: params.timeoutMs)
            let isPrecise = await services.locationAccuracyAuthorization() == .fullAccuracy
            let payload = OpenClawLocationPayload(
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
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_TIMEOUT: no fix in time"))
        } catch {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "LOCATION_UNAVAILABLE: \(error.localizedDescription)"))
        }
    }

    private func handleComputerActInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        guard self.computerControlEnabled() else {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "COMPUTER_DISABLED: enable Computer Control in Settings"))
        }
        let params: OpenClawComputerActParams
        do {
            params = try Self.decodeParams(OpenClawComputerActParams.self, from: req.paramsJSON)
        } catch {
            return Self.errorResponse(
                req,
                code: .invalidRequest,
                message: "INVALID_REQUEST: invalid computer.act params")
        }
        let releaseGenerationAtStart = self.computerInputReleaseGeneration
        let services = await mainActorServices()
        guard self.computerInputReleaseGeneration == releaseGenerationAtStart else {
            return Self.errorResponse(
                req,
                code: .unavailable,
                message: "UNAVAILABLE: computer control lifecycle changed")
        }
        try Task.checkCancellation()
        do {
            let result = try await services.performComputerAct(
                params,
                lifecycleGeneration: releaseGenerationAtStart)
            let payload = try Self.encodePayload(result)
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        } catch let error as ComputerActionService.ComputerActionError {
            switch error {
            case .accessibilityNotTrusted:
                return Self.errorResponse(
                    req,
                    code: .unavailable,
                    message: "ACCESSIBILITY_REQUIRED: grant Accessibility permission to OpenClaw")
            case .accessibilityGrantMayBeStale:
                return Self.errorResponse(
                    req,
                    code: .unavailable,
                    message: "ACCESSIBILITY_REQUIRED: "
                        + ComputerControlPermissionSnapshot.Diagnostic.staleAccessibilityRemediation)
            case .postEventAccessDenied:
                return Self.errorResponse(
                    req,
                    code: .unavailable,
                    message: "POST_EVENT_REQUIRED: macOS denied Event Posting access; re-grant OpenClaw "
                        + "under System Settings → Privacy & Security → Accessibility")
            case .noDisplays, .invalidScreenIndex, .missingDisplayFrameId, .displayFrameChanged,
                 .missingCoordinate, .coordinateOutOfBounds, .invalidReferenceWidth, .missingKeys,
                 .emptyText, .invalidScroll, .invalidModifier, .buttonAlreadyHeld, .buttonNotHeld,
                 .invalidRequest, .staleObservation, .unsupportedAction:
                return Self.errorResponse(
                    req,
                    code: .invalidRequest,
                    message: error.localizedDescription.hasPrefix("COMPUTER_")
                        ? error.localizedDescription
                        : "INVALID_REQUEST: \(error.localizedDescription)")
            case .eventCreationFailed, .lifecycleChanged, .refused:
                return Self.errorResponse(
                    req,
                    code: .unavailable,
                    message: error.localizedDescription.hasPrefix("COMPUTER_")
                        ? error.localizedDescription
                        : "UNAVAILABLE: \(error.localizedDescription)")
            }
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
        let services = await mainActorServices()
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

    private func handleScreenSnapshotInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params: MacNodeScreenSnapshotParams
        if let paramsJSON = req.paramsJSON {
            do {
                params = try Self.decodeParams(MacNodeScreenSnapshotParams.self, from: paramsJSON)
            } catch {
                return Self.errorResponse(
                    req,
                    code: .invalidRequest,
                    message: "INVALID_REQUEST: invalid screen snapshot params")
            }
        } else {
            params = MacNodeScreenSnapshotParams()
        }
        let services = await mainActorServices()
        let capturedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        let res: ScreenSnapshotResult
        do {
            res = try await services.snapshotScreen(
                screenIndex: params.screenIndex,
                maxWidth: params.maxWidth,
                quality: params.quality,
                format: params.format)
        } catch let error as ScreenSnapshotService.ScreenSnapshotError {
            switch error {
            case .noDisplays:
                return Self.errorResponse(
                    req,
                    code: .invalidRequest,
                    message: "INVALID_REQUEST: no displays available for screen snapshot")
            case let .invalidScreenIndex(idx):
                return Self.errorResponse(
                    req,
                    code: .invalidRequest,
                    message: "INVALID_REQUEST: invalid screen index \(idx)")
            case .captureFailed, .encodeFailed:
                return Self.errorResponse(
                    req,
                    code: .unavailable,
                    message: "UNAVAILABLE: screen snapshot failed")
            }
        } catch {
            return Self.errorResponse(
                req,
                code: .unavailable,
                message: "UNAVAILABLE: screen snapshot failed")
        }
        if res.data.count > Self.maxScreenSnapshotRawBytesBeforeBase64 {
            return Self.screenSnapshotPayloadTooLarge(req)
        }
        struct ScreenSnapshotPayload: Encodable {
            var format: String
            var base64: String
            var displayFrameId: String
            var width: Int
            var height: Int
            var screenIndex: Int?
            var capturedAtMs: Int64
        }
        let payload = try Self.encodePayload(ScreenSnapshotPayload(
            format: res.format.rawValue,
            base64: res.data.base64EncodedString(),
            displayFrameId: res.displayFrameId,
            width: res.width,
            height: res.height,
            screenIndex: params.screenIndex,
            capturedAtMs: capturedAtMs))
        if try Self.projectedOuterFrameBytes(
            forPayloadJSON: payload,
            requestId: req.id,
            nodeId: req.nodeId) > Self.maxGatewayPayloadBytes
        {
            return Self.screenSnapshotPayloadTooLarge(req)
        }
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }

    private func mainActorServices() async -> any MacNodeRuntimeMainActorServices {
        if let cachedMainActorServices {
            return cachedMainActorServices
        }
        let task: Task<any MacNodeRuntimeMainActorServices, Never>
        if let initializationTask = mainActorServicesInitializationTask {
            task = initializationTask
        } else {
            let makeMainActorServices = self.makeMainActorServices
            let initializationTask = Task {
                await makeMainActorServices()
            }
            self.mainActorServicesInitializationTask = initializationTask
            task = initializationTask
        }
        let services = await task.value
        if cachedMainActorServices == nil {
            cachedMainActorServices = services
            self.mainActorServicesInitializationTask = nil
        }
        return cachedMainActorServices ?? services
    }

    /// Releases any synthetic input the computer.act service is still holding
    /// (a left_mouse_down without its matching up) on lifecycle transitions:
    /// node disconnect, node stop, or Computer Control disabled. Uses the cached
    /// services directly so it never spins up services just to release nothing.
    func releaseHeldComputerInput() async {
        self.computerInputReleaseGeneration &+= 1
        let lifecycleGeneration = self.computerInputReleaseGeneration
        await self.cachedMainActorServices?.releaseHeldInput(
            lifecycleGeneration: lifecycleGeneration)
    }

    func shutdown() async {
        await self.codexThreadCatalogClient.shutdown()
    }
}

// MARK: - Native system notifications

extension MacNodeRuntime {
    private func handleSystemNotify(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(OpenClawSystemNotifyParams.self, from: req.paramsJSON)
        let title = params.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = params.body.trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty, body.isEmpty {
            return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: empty notification")
        }

        let priority = params.priority.flatMap { NotificationPriority(rawValue: $0.rawValue) }
        let delivery = params.delivery.flatMap { NotificationDelivery(rawValue: $0.rawValue) } ?? .system
        let manager = NotificationManager()

        if delivery != .overlay {
            let ok = await manager.send(
                title: title,
                body: body,
                sound: params.sound,
                priority: priority)
            if ok {
                return BridgeInvokeResponse(id: req.id, ok: true)
            }
            try Task.checkCancellation()
            if delivery == .system {
                return Self.errorResponse(req, code: .unavailable, message: "NOT_AUTHORIZED: notifications")
            }
        }
        try await MainActor.run {
            try Task.checkCancellation()
            NotifyOverlayController.shared.present(title: title, body: body)
        }
        return BridgeInvokeResponse(id: req.id, ok: true)
    }
}

// MARK: - Shared command support

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

    static func projectedOuterFrameBytes(
        forPayloadJSON payloadJSON: String,
        requestId: String,
        nodeId: String?) throws -> Int
    {
        struct InvokeResultFrame: Encodable {
            let type = "req"
            let id = "00000000-0000-0000-0000-000000000000"
            let method = "node.invoke.result"
            let params: Params

            struct Params: Encodable {
                let id: String
                let nodeId: String
                let ok: Bool
                let payloadJSON: String
            }
        }

        let frame = InvokeResultFrame(params: InvokeResultFrame.Params(
            id: requestId,
            nodeId: nodeId ?? "",
            ok: true,
            payloadJSON: payloadJSON))
        return try JSONEncoder().encode(frame).count
    }

    private static func screenSnapshotPayloadTooLarge(_ req: BridgeInvokeRequest) -> BridgeInvokeResponse {
        self.errorResponse(
            req,
            code: .unavailable,
            message: "UNAVAILABLE: screen snapshot payload too large; reduce maxWidth or use jpeg")
    }

    private nonisolated static func canvasEnabled() -> Bool {
        AppDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
    }

    private nonisolated static func cameraEnabled() -> Bool {
        AppDefaults.standard.object(forKey: cameraEnabledKey) as? Bool ?? false
    }

    nonisolated static func computerControlEnabledDefault() -> Bool {
        isComputerControlEnabled()
    }

    private nonisolated static func locationMode() -> OpenClawLocationMode {
        let raw = AppDefaults.standard.string(forKey: locationModeKey) ?? "off"
        return OpenClawLocationMode(rawValue: raw) ?? .off
    }

    private nonisolated static func locationPreciseEnabled() -> Bool {
        if AppDefaults.standard.object(forKey: locationPreciseKey) == nil {
            return true
        }
        return AppDefaults.standard.bool(forKey: locationPreciseKey)
    }

    private static func errorResponse(
        _ req: BridgeInvokeRequest,
        code: OpenClawNodeErrorCode,
        message: String) -> BridgeInvokeResponse
    {
        BridgeInvokeResponse(
            id: req.id,
            ok: false,
            error: OpenClawNodeError(code: code, message: message))
    }
}

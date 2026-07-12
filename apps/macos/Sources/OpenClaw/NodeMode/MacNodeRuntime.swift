import AppKit
import Foundation
import OpenClawIPC
import OpenClawKit

actor MacNodeRuntime {
    private static let maxGatewayPayloadBytes = 25 * 1024 * 1024
    private static let maxScreenSnapshotRawBytesBeforeBase64 = (maxGatewayPayloadBytes / 4) * 3
    private let cameraCapture = CameraCaptureService()
    private let nodeHostWorker: (any MacNodeHostWorking)?
    private let makeMainActorServices: @Sendable () async -> any MacNodeRuntimeMainActorServices
    // Injectable so tests pin the gate instead of racing on process-global UserDefaults.
    private let computerControlEnabled: @Sendable () -> Bool
    private let canvasHostedSurfaceResolver: MacNodeCanvasHostedSurfaceResolver
    private let codexThreadCatalogEnabled: @Sendable () -> Bool
    private let codexThreadListRequest: @Sendable (String?) async throws -> String
    private let codexThreadTurnsRequest: @Sendable (String?) async throws -> String
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
        makeMainActorServices: @escaping @Sendable () async -> any MacNodeRuntimeMainActorServices = {
            await MainActor.run { LiveMacNodeRuntimeMainActorServices() }
        },
        computerControlEnabled: @escaping @Sendable () -> Bool = {
            MacNodeRuntime.computerControlEnabledDefault()
        },
        canvasSurfaceUrl: @escaping @Sendable () async -> String? = {
            await GatewayConnection.shared.canvasPluginSurfaceUrl()
        },
        refreshCanvasSurfaceUrl: @escaping @Sendable () async -> String? = { nil },
        codexThreadCatalogEnabled: @escaping @Sendable () -> Bool = {
            MacNodeCodexThreadCatalog.shouldAdvertise()
        },
        codexThreadListRequest: @escaping @Sendable (String?) async throws -> String = { paramsJSON in
            try await MacNodeCodexThreadCatalog.list(paramsJSON: paramsJSON)
        },
        codexThreadTurnsRequest: @escaping @Sendable (String?) async throws -> String = { paramsJSON in
            try await MacNodeCodexThreadCatalog.turns(paramsJSON: paramsJSON)
        },
        claudeSessionCatalogEnabled: @escaping @Sendable () -> Bool = {
            MacNodeClaudeSessionCatalog.shouldAdvertise()
        },
        claudeSessionListRequest: @escaping @Sendable (String?) async throws -> String = { paramsJSON in
            try MacNodeClaudeSessionCatalog.list(paramsJSON: paramsJSON)
        },
        claudeSessionReadRequest: @escaping @Sendable (String?) async throws -> String = { paramsJSON in
            try MacNodeClaudeSessionCatalog.read(paramsJSON: paramsJSON)
        })
    {
        self.nodeHostWorker = nodeHostWorker
        self.makeMainActorServices = makeMainActorServices
        self.computerControlEnabled = computerControlEnabled
        self.canvasHostedSurfaceResolver = MacNodeCanvasHostedSurfaceResolver(
            currentSurfaceURL: canvasSurfaceUrl,
            refreshSurfaceURL: refreshCanvasSurfaceUrl)
        self.codexThreadCatalogEnabled = codexThreadCatalogEnabled
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
        if let nodeHostWorker, await nodeHostWorker.supports(command) {
            return await nodeHostWorker.invoke(req)
        }
        if self.isCanvasCommand(command), !Self.canvasEnabled() {
            return BridgeInvokeResponse(
                id: req.id,
                ok: false,
                error: OpenClawNodeError(
                    code: .unavailable,
                    message: "CANVAS_DISABLED: enable Canvas in Settings"))
        }
        do {
            switch command {
            case OpenClawCanvasCommand.present.rawValue,
                 OpenClawCanvasCommand.hide.rawValue,
                 OpenClawCanvasCommand.navigate.rawValue,
                 OpenClawCanvasCommand.evalJS.rawValue,
                 OpenClawCanvasCommand.snapshot.rawValue:
                return try await self.handleCanvasInvoke(req)
            case OpenClawCanvasA2UICommand.reset.rawValue,
                 OpenClawCanvasA2UICommand.push.rawValue,
                 OpenClawCanvasA2UICommand.pushJSONL.rawValue:
                return try await self.handleA2UIInvoke(req)
            case OpenClawCameraCommand.snap.rawValue,
                 OpenClawCameraCommand.clip.rawValue,
                 OpenClawCameraCommand.list.rawValue:
                return try await self.handleCameraInvoke(req)
            case OpenClawLocationCommand.get.rawValue:
                return try await self.handleLocationInvoke(req)
            case MacNodeScreenCommand.snapshot.rawValue:
                return try await self.handleScreenSnapshotInvoke(req)
            case MacNodeScreenCommand.record.rawValue:
                return try await self.handleScreenRecordInvoke(req)
            case OpenClawComputerCommand.act.rawValue:
                return try await self.handleComputerActInvoke(req)
            case OpenClawSystemCommand.notify.rawValue:
                return try await self.handleSystemNotify(req)
            case MacNodeCodexThreadCatalogContract.listCommand,
                 MacNodeCodexThreadCatalogContract.turnsCommand:
                return try await self.handleCodexThreadInvoke(req)
            case MacNodeClaudeSessionCatalogContract.listCommand,
                 MacNodeClaudeSessionCatalogContract.readCommand:
                return try await self.handleClaudeSessionInvoke(req)
            default:
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
        } catch {
            return Self.errorResponse(req, code: .unavailable, message: error.localizedDescription)
        }
    }

    private func isCanvasCommand(_ command: String) -> Bool {
        command.hasPrefix("canvas.") || command.hasPrefix("canvas.a2ui.")
    }

    private func handleCodexThreadInvoke(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        guard self.codexThreadCatalogEnabled() else {
            return Self.errorResponse(
                req,
                code: .unavailable,
                message: "UNAVAILABLE: Codex session catalog is disabled")
        }
        let request = req.command == MacNodeCodexThreadCatalogContract.listCommand
            ? self.codexThreadListRequest
            : self.codexThreadTurnsRequest
        let payload = try await request(req.paramsJSON)
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
            let hostedTarget = try await self.canvasHostedSurfaceResolver.resolveTarget(url)
            let effectiveURL = hostedTarget?.url.absoluteString ?? url
            let placement = params.placement.map {
                CanvasPlacement(x: $0.x, y: $0.y, width: $0.width, height: $0.height)
            }
            let sessionKey = self.mainSessionKey
            try await MainActor.run {
                _ = try CanvasManager.shared.showDetailed(
                    sessionKey: sessionKey,
                    target: effectiveURL,
                    placement: placement,
                    trustedA2UIActions: hostedTarget?.allowsA2UIActions == true)
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
            let hostedTarget = try await self.canvasHostedSurfaceResolver.resolveTarget(params.url)
            let effectiveURL = hostedTarget?.url.absoluteString ?? params.url
            let sessionKey = self.mainSessionKey
            try await MainActor.run {
                _ = try CanvasManager.shared.show(
                    sessionKey: sessionKey,
                    path: effectiveURL,
                    trustedA2UIActions: hostedTarget?.allowsA2UIActions == true)
            }
            return BridgeInvokeResponse(id: req.id, ok: true)
        case OpenClawCanvasCommand.evalJS.rawValue:
            let params = try Self.decodeParams(OpenClawCanvasEvalParams.self, from: req.paramsJSON)
            let sessionKey = self.mainSessionKey
            let result = try await CanvasManager.shared.eval(
                sessionKey: sessionKey,
                javaScript: params.javaScript)
            let payload = try Self.encodePayload(["result": result] as [String: String])
            return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
        case OpenClawCanvasCommand.snapshot.rawValue:
            let params = try? Self.decodeParams(OpenClawCanvasSnapshotParams.self, from: req.paramsJSON)
            let format = params?.format ?? .jpeg
            let maxWidth: Int? = {
                if let raw = params?.maxWidth, raw > 0 {
                    return raw
                }
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
        case OpenClawCanvasA2UICommand.reset.rawValue:
            try await self.handleA2UIReset(req)
        case OpenClawCanvasA2UICommand.push.rawValue,
             OpenClawCanvasA2UICommand.pushJSONL.rawValue:
            try await self.handleA2UIPush(req)
        default:
            Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: unknown command")
        }
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
            case .noDisplays, .invalidScreenIndex, .missingDisplayFrameId, .displayFrameChanged,
                 .missingCoordinate, .coordinateOutOfBounds, .invalidReferenceWidth, .missingKeys,
                 .emptyText, .invalidScroll, .invalidModifier, .buttonAlreadyHeld, .buttonNotHeld:
                return Self.errorResponse(
                    req,
                    code: .invalidRequest,
                    message: "INVALID_REQUEST: \(error.localizedDescription)")
            case .eventCreationFailed, .lifecycleChanged:
                return Self.errorResponse(
                    req,
                    code: .unavailable,
                    message: "UNAVAILABLE: \(error.localizedDescription)")
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
}

// MARK: - A2UI host

extension MacNodeRuntime {
    private func handleA2UIReset(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        try await self.ensureA2UIHost()

        let sessionKey = self.mainSessionKey
        let json = try await CanvasManager.shared.eval(sessionKey: sessionKey, javaScript: """
        (() => {
          const host = globalThis.openclawA2UI;
          if (!host) return JSON.stringify({ ok: false, error: "missing openclawA2UI" });
          return JSON.stringify(host.reset());
        })()
        """)
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: json)
    }

    private func handleA2UIPush(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let command = req.command
        let messages: [OpenClawKit.AnyCodable]
        if command == OpenClawCanvasA2UICommand.pushJSONL.rawValue {
            let params = try Self.decodeParams(OpenClawCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
            messages = try OpenClawCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
        } else {
            do {
                let params = try Self.decodeParams(OpenClawCanvasA2UIPushParams.self, from: req.paramsJSON)
                messages = params.messages
            } catch {
                let params = try Self.decodeParams(OpenClawCanvasA2UIPushJSONLParams.self, from: req.paramsJSON)
                messages = try OpenClawCanvasA2UIJSONL.decodeMessagesFromJSONL(params.jsonl)
            }
        }

        try await self.ensureA2UIHost()

        let messagesJSON = try OpenClawCanvasA2UIJSONL.encodeMessagesJSONArray(messages)
        let js = """
        (() => {
          try {
            const host = globalThis.openclawA2UI;
            if (!host) return JSON.stringify({ ok: false, error: "missing openclawA2UI" });
            const messages = \(messagesJSON);
            return JSON.stringify(host.applyMessages(messages));
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
        if await self.isA2UIReady() {
            return
        }
        guard let a2uiUrl = await self.canvasHostedSurfaceResolver.resolveA2UIURL() else {
            throw NSError(domain: "Canvas", code: 30, userInfo: [
                NSLocalizedDescriptionKey: "A2UI_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
            ])
        }
        let sessionKey = self.mainSessionKey
        _ = try await MainActor.run {
            try CanvasManager.shared.show(
                sessionKey: sessionKey,
                path: a2uiUrl,
                trustedA2UIActions: true)
        }
        if await self.isA2UIReady(poll: true) {
            return
        }
        if let refreshedUrl = await self.canvasHostedSurfaceResolver.resolveA2UIURL(forceRefresh: true) {
            _ = try await MainActor.run {
                try CanvasManager.shared.show(
                    sessionKey: sessionKey,
                    path: refreshedUrl,
                    trustedA2UIActions: true)
            }
            if await self.isA2UIReady(poll: true) {
                return
            }
        }
        throw NSError(domain: "Canvas", code: 31, userInfo: [
            NSLocalizedDescriptionKey: "A2UI_HOST_UNAVAILABLE: A2UI host not reachable",
        ])
    }

    private func isA2UIReady(poll: Bool = false) async -> Bool {
        let deadline = poll ? Date().addingTimeInterval(6.0) : Date()
        while true {
            do {
                let sessionKey = self.mainSessionKey
                let ready = try await CanvasManager.shared.eval(sessionKey: sessionKey, javaScript: """
                (() => {
                  const host = globalThis.openclawA2UI;
                  return String(Boolean(host));
                })()
                """)
                let trimmed = ready.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed == "true" {
                    return true
                }
            } catch {
                // Ignore transient eval failures while the page is loading.
            }

            guard poll, Date() < deadline else { return false }
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
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
        UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
    }

    private nonisolated static func cameraEnabled() -> Bool {
        UserDefaults.standard.object(forKey: cameraEnabledKey) as? Bool ?? false
    }

    nonisolated static func computerControlEnabledDefault() -> Bool {
        UserDefaults.standard.object(forKey: computerControlEnabledKey) as? Bool ?? false
    }

    private nonisolated static func locationMode() -> OpenClawLocationMode {
        let raw = UserDefaults.standard.string(forKey: locationModeKey) ?? "off"
        return OpenClawLocationMode(rawValue: raw) ?? .off
    }

    private nonisolated static func locationPreciseEnabled() -> Bool {
        if UserDefaults.standard.object(forKey: locationPreciseKey) == nil {
            return true
        }
        return UserDefaults.standard.bool(forKey: locationPreciseKey)
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

    private static func encodeCanvasSnapshot(
        image: NSImage,
        format: OpenClawCanvasSnapshotFormat,
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

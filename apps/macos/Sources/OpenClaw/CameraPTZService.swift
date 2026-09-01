import Foundation
import OpenClawKit

struct CameraPTZAxisStatus: Encodable, Equatable, Sendable {
    let current: Double
    let min: Double
    let max: Double
    let step: Double
    let `default`: Double?
    let unit: String
    let canSet: Bool
    let canMove: Bool
}

struct CameraPTZAxesStatus: Encodable, Equatable, Sendable {
    let pan: CameraPTZAxisStatus?
    let tilt: CameraPTZAxisStatus?
    let zoom: CameraPTZAxisStatus?
}

struct CameraPTZStatusResponse: Encodable, Equatable, Sendable {
    let deviceId: String
    let axes: CameraPTZAxesStatus
    let canHome: Bool
}

struct CameraPTZState: Encodable, Equatable, Sendable {
    let panDegrees: Double?
    let tiltDegrees: Double?
    let zoomPercent: Double?
}

struct CameraPTZControlResponse: Encodable, Equatable, Sendable {
    let deviceId: String
    let operation: OpenClawCameraPTZOperation
    let state: CameraPTZState
    let adjusted: [String]
}

enum CameraPTZError: LocalizedError, Equatable {
    case invalidRequest(String)
    case deviceNotFound(String)
    case unsupported(String)
    case axisUnsupported(String)
    case partial(applied: [String], state: CameraPTZState?, failure: String)

    var errorDescription: String? {
        switch self {
        case let .invalidRequest(message):
            "INVALID_REQUEST: \(message)"
        case let .deviceNotFound(deviceId):
            "CAMERA_DEVICE_NOT_FOUND: \(deviceId); run camera.list for current device IDs"
        case let .unsupported(message):
            "CAMERA_PTZ_UNSUPPORTED: \(message)"
        case let .axisUnsupported(axis):
            "CAMERA_PTZ_AXIS_UNSUPPORTED: \(axis)"
        case let .partial(applied, state, failure):
            "CAMERA_PTZ_PARTIAL: applied=\(applied.joined(separator: ",")); " +
                "state=\(Self.describe(state)); failure=\(failure); " +
                "run camera.ptz.status before retrying"
        }
    }

    private static func describe(_ state: CameraPTZState?) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let state,
              let data = try? encoder.encode(state),
              let json = String(data: data, encoding: .utf8)
        else { return "unavailable" }
        return json
    }
}

protocol CameraPTZServicing: Sendable {
    func status(deviceId: String) async throws -> CameraPTZStatusResponse
    func control(_ params: OpenClawCameraPTZControlParams) async throws -> CameraPTZControlResponse
}

struct CameraPTZRawRange: Equatable, Sendable {
    let min: Int32
    let max: Int32
    let step: Int32
    let `default`: Int32?

    func normalize(_ value: Int32) -> Int32 {
        var normalized = Int64(value)
        if self.step > 1 {
            let steps = (Double(Int64(value) - Int64(self.min)) / Double(self.step)).rounded()
            normalized = Int64(self.min) + Int64(steps) * Int64(self.step)
        }
        return Int32(clamping: Swift.min(Int64(self.max), Swift.max(Int64(self.min), normalized)))
    }

    func percent(of value: Int32) -> Double {
        guard self.max > self.min else { return 0 }
        let normalized = self.normalize(value)
        return Double(Int64(normalized) - Int64(self.min)) /
            Double(Int64(self.max) - Int64(self.min)) * 100
    }

    func value(percent: Double) -> Int32 {
        guard self.max > self.min else { return self.min }
        let clamped = Swift.min(100, Swift.max(0, percent))
        let raw = Double(self.min) + clamped / 100 * Double(Int64(self.max) - Int64(self.min))
        return self.normalize(Int32(clamping: Int64(raw.rounded())))
    }

    func withDefault(_ value: Int32?) -> CameraPTZRawRange {
        CameraPTZRawRange(
            min: self.min,
            max: self.max,
            step: self.step,
            default: value.map(self.normalize))
    }
}

struct CameraPTZRawAxisStatus: Equatable, Sendable {
    let current: Int32
    let range: CameraPTZRawRange
    let canSet: Bool
}

struct CameraPTZRawStatus: Equatable, Sendable {
    let pan: CameraPTZRawAxisStatus?
    let tilt: CameraPTZRawAxisStatus?
    let zoom: CameraPTZRawAxisStatus?
}

protocol CameraPTZControlling: AnyObject {
    func status() throws -> CameraPTZRawStatus
    func setPanTilt(pan: Int32, tilt: Int32) throws
    func setZoom(_ zoom: Int32) throws
    func close()
}

protocol CameraPTZBackend: Sendable {
    func open(deviceId: String) throws -> any CameraPTZControlling
    func withCaptureSession<T>(deviceId: String, body: () throws -> T) throws -> T
}

actor CameraPTZService: CameraPTZServicing {
    private struct WritePlan {
        let panTilt: (pan: Int32, tilt: Int32)?
        let zoom: Int32?
        let adjusted: [String]
    }

    private let backend: any CameraPTZBackend
    private let deviceExists: @Sendable (String) -> Bool

    init(
        backend: any CameraPTZBackend = NativeCameraPTZBackend(),
        deviceExists: @escaping @Sendable (String) -> Bool = {
            CameraDeviceResolver.camera(deviceId: $0) != nil
        })
    {
        self.backend = backend
        self.deviceExists = deviceExists
    }

    func status(deviceId: String) throws -> CameraPTZStatusResponse {
        let deviceId = try self.resolveDeviceId(deviceId)
        return try self.backend.withCaptureSession(deviceId: deviceId) {
            try self.withController(deviceId: deviceId) { controller in
                try Self.makeStatusResponse(deviceId: deviceId, raw: controller.status())
            }
        }
    }

    func control(_ params: OpenClawCameraPTZControlParams) throws -> CameraPTZControlResponse {
        let deviceId = try self.resolveDeviceId(params.deviceId)
        let axes = try Self.validateControl(params)
        return try self.backend.withCaptureSession(deviceId: deviceId) {
            try self.withController(deviceId: deviceId) { controller in
                let status = try Self.executableStatus(controller.status())
                let plan = switch params.operation {
                case .home: try Self.planHome(status: status)
                case .set, .move: try Self.planMotion(
                        status: status,
                        operation: params.operation,
                        axes: axes)
                }
                return try self.execute(
                    plan: plan,
                    controller: controller,
                    deviceId: deviceId,
                    operation: params.operation)
            }
        }
    }

    private func resolveDeviceId(_ value: String) throws -> String {
        let deviceId = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !deviceId.isEmpty else {
            throw CameraPTZError.invalidRequest("deviceId is required")
        }
        guard self.deviceExists(deviceId) else {
            throw CameraPTZError.deviceNotFound(deviceId)
        }
        return deviceId
    }

    private func withController<T>(
        deviceId: String,
        body: (any CameraPTZControlling) throws -> T) throws -> T
    {
        let controller: any CameraPTZControlling
        do {
            controller = try self.backend.open(deviceId: deviceId)
        } catch let error as CameraPTZError {
            throw error
        } catch {
            throw CameraPTZError.unsupported(error.localizedDescription)
        }
        defer { controller.close() }
        do {
            return try body(controller)
        } catch let error as CameraPTZError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw CameraPTZError.unsupported(error.localizedDescription)
        }
    }

    private static func validateControl(
        _ params: OpenClawCameraPTZControlParams) throws -> OpenClawCameraPTZAxisValues
    {
        switch params.operation {
        case .home:
            guard params.target == nil, params.delta == nil else {
                throw CameraPTZError.invalidRequest("home does not accept target or delta")
            }
            return OpenClawCameraPTZAxisValues()
        case .set:
            guard let target = params.target, params.delta == nil else {
                throw CameraPTZError.invalidRequest("set requires target and does not accept delta")
            }
            try self.validateAxes(target)
            return target
        case .move:
            guard let delta = params.delta, params.target == nil else {
                throw CameraPTZError.invalidRequest("move requires delta and does not accept target")
            }
            try self.validateAxes(delta)
            return delta
        }
    }

    private static func validateAxes(_ axes: OpenClawCameraPTZAxisValues) throws {
        let values = [axes.panDegrees, axes.tiltDegrees, axes.zoomPercent].compactMap(\.self)
        guard !values.isEmpty else {
            throw CameraPTZError.invalidRequest("set and move require at least one axis")
        }
        guard values.allSatisfy(\.isFinite) else {
            throw CameraPTZError.invalidRequest("axis values must be finite")
        }
    }

    private static func planMotion(
        status: CameraPTZRawStatus,
        operation: OpenClawCameraPTZOperation,
        axes: OpenClawCameraPTZAxisValues) throws -> WritePlan
    {
        // Relative hardware flags are unreliable across UVC cameras. Match the
        // proven adapter behavior by reading current state and writing absolute values.
        if axes.panDegrees != nil, status.pan == nil {
            throw CameraPTZError.axisUnsupported("pan")
        }
        if axes.tiltDegrees != nil, status.tilt == nil {
            throw CameraPTZError.axisUnsupported("tilt")
        }
        if axes.zoomPercent != nil, status.zoom == nil {
            throw CameraPTZError.axisUnsupported("zoom")
        }

        var adjusted: [String] = []
        var plannedPanTilt: (pan: Int32, tilt: Int32)?
        if axes.panDegrees != nil || axes.tiltDegrees != nil {
            guard let pan = status.pan, let tilt = status.tilt else {
                throw CameraPTZError.axisUnsupported(axes.panDegrees != nil ? "pan" : "tilt")
            }
            let appliedPan: Int32
            if let panDegrees = axes.panDegrees {
                let requested = Self.requestedDegrees(
                    value: panDegrees,
                    current: Self.arcsecondsToDegrees(pan.current),
                    operation: operation)
                appliedPan = pan.range.normalize(Self.degreesToArcseconds(requested))
                if Self.valuesDiffer(Self.arcsecondsToDegrees(appliedPan), requested) {
                    adjusted.append("panDegrees")
                }
            } else {
                appliedPan = pan.current
            }
            let appliedTilt: Int32
            if let tiltDegrees = axes.tiltDegrees {
                let requested = Self.requestedDegrees(
                    value: tiltDegrees,
                    current: Self.arcsecondsToDegrees(tilt.current),
                    operation: operation)
                appliedTilt = tilt.range.normalize(Self.degreesToArcseconds(requested))
                if Self.valuesDiffer(Self.arcsecondsToDegrees(appliedTilt), requested) {
                    adjusted.append("tiltDegrees")
                }
            } else {
                appliedTilt = tilt.current
            }
            plannedPanTilt = (appliedPan, appliedTilt)
        }

        var plannedZoom: Int32?
        if let zoomValue = axes.zoomPercent, let zoom = status.zoom {
            let requested = operation == .move ? zoom.range.percent(of: zoom.current) + zoomValue : zoomValue
            plannedZoom = zoom.range.value(percent: requested)
            if let plannedZoom, Self.valuesDiffer(zoom.range.percent(of: plannedZoom), requested) {
                adjusted.append("zoomPercent")
            }
        }
        return WritePlan(panTilt: plannedPanTilt, zoom: plannedZoom, adjusted: adjusted)
    }

    private static func planHome(status: CameraPTZRawStatus) throws -> WritePlan {
        guard self.canHome(status) else {
            throw CameraPTZError.unsupported(
                "home requires device-advertised defaults for every executable axis")
        }
        let panTilt: (pan: Int32, tilt: Int32)? = if let panDefault = status.pan?.range.default,
                                                     let tiltDefault = status.tilt?.range.default
        {
            (panDefault, tiltDefault)
        } else {
            nil
        }
        return WritePlan(panTilt: panTilt, zoom: status.zoom?.range.default, adjusted: [])
    }

    private static func requestedDegrees(
        value: Double,
        current: Double,
        operation: OpenClawCameraPTZOperation) -> Double
    {
        operation == .move ? current + value : value
    }

    private func execute(
        plan: WritePlan,
        controller: any CameraPTZControlling,
        deviceId: String,
        operation: OpenClawCameraPTZOperation) throws -> CameraPTZControlResponse
    {
        // Cancellation owns admission only. Once the first physical write starts,
        // finish the preflighted sequence while route teardown awaits this task.
        try Task.checkCancellation()
        var applied: [String] = []
        do {
            if let panTilt = plan.panTilt {
                try controller.setPanTilt(pan: panTilt.pan, tilt: panTilt.tilt)
                applied.append("panTilt")
            }
            if let zoom = plan.zoom {
                try controller.setZoom(zoom)
                applied.append("zoom")
            }
        } catch {
            guard !applied.isEmpty else { throw error }
            controller.close()
            throw self.partialError(applied: applied, deviceId: deviceId, failure: error)
        }

        // A writing UVC connection can echo its pending setpoint instead of the committed camera position.
        controller.close()
        let finalStatus: CameraPTZRawStatus
        var statusFailure: Error?
        do {
            finalStatus = try self.withController(deviceId: deviceId) {
                do {
                    return try Self.executableStatus($0.status())
                } catch {
                    statusFailure = error
                    throw error
                }
            }
        } catch {
            throw self.partialError(applied: applied, deviceId: deviceId, failure: statusFailure ?? error)
        }

        let requestedAxes: [(String, Int32?, CameraPTZRawAxisStatus?)] = [
            ("panDegrees", plan.panTilt?.pan, finalStatus.pan),
            ("tiltDegrees", plan.panTilt?.tilt, finalStatus.tilt),
            ("zoomPercent", plan.zoom, finalStatus.zoom),
        ]
        var mismatches: [String] = []
        for (name, target, axis) in requestedAxes {
            guard let target else { continue }
            guard let axis else {
                mismatches.append("\(name) requested=\(target) observed=unavailable")
                continue
            }
            guard abs(Int64(axis.current) - Int64(target)) > Int64(max(0, axis.range.step)) else {
                continue
            }
            let requested = name == "zoomPercent"
                ? axis.range.percent(of: target)
                : Self.arcsecondsToDegrees(target)
            let observed = name == "zoomPercent"
                ? axis.range.percent(of: axis.current)
                : Self.arcsecondsToDegrees(axis.current)
            mismatches.append("\(name) requested=\(requested) observed=\(observed)")
        }
        guard mismatches.isEmpty else {
            throw CameraPTZError.partial(
                applied: applied,
                state: Self.makeState(finalStatus),
                failure: mismatches.joined(separator: "; ") +
                    "; confirm a video stream reaches the camera and disable on-camera AI framing/tracking")
        }
        return CameraPTZControlResponse(
            deviceId: deviceId,
            operation: operation,
            state: Self.makeState(finalStatus),
            adjusted: plan.adjusted)
    }

    private func partialError(
        applied: [String],
        deviceId: String,
        failure: Error) -> CameraPTZError
    {
        let state = try? self.withController(deviceId: deviceId) {
            try Self.makeState(Self.executableStatus($0.status()))
        }
        return .partial(
            applied: applied,
            state: state,
            failure: failure.localizedDescription)
    }

    private static func degreesToArcseconds(_ degrees: Double) -> Int32 {
        let raw = degrees * 3600
        if raw >= Double(Int32.max) { return Int32.max }
        if raw <= Double(Int32.min) { return Int32.min }
        return Int32(raw.rounded())
    }

    private static func arcsecondsToDegrees(_ arcseconds: Int32) -> Double {
        Double(arcseconds) / 3600
    }

    private static func valuesDiffer(_ lhs: Double, _ rhs: Double) -> Bool {
        abs(lhs - rhs) > 1e-9
    }

    private static func makeStatusResponse(
        deviceId: String,
        raw: CameraPTZRawStatus) -> CameraPTZStatusResponse
    {
        let raw = self.executableStatus(raw)
        let axes = CameraPTZAxesStatus(
            pan: raw.pan.map { self.angleStatus($0) },
            tilt: raw.tilt.map { self.angleStatus($0) },
            zoom: raw.zoom.map { self.zoomStatus($0) })
        return CameraPTZStatusResponse(
            deviceId: deviceId,
            axes: axes,
            canHome: self.canHome(raw))
    }

    private static func executableStatus(_ raw: CameraPTZRawStatus) -> CameraPTZRawStatus {
        let panTiltSettable = raw.pan?.canSet == true && raw.tilt?.canSet == true
        return CameraPTZRawStatus(
            pan: panTiltSettable ? raw.pan : nil,
            tilt: panTiltSettable ? raw.tilt : nil,
            zoom: raw.zoom?.canSet == true ? raw.zoom : nil)
    }

    private static func canHome(_ status: CameraPTZRawStatus) -> Bool {
        let axes = [status.pan, status.tilt, status.zoom].compactMap(\.self)
        return !axes.isEmpty && axes.allSatisfy { $0.range.default != nil }
    }

    private static func makeState(_ raw: CameraPTZRawStatus) -> CameraPTZState {
        CameraPTZState(
            panDegrees: raw.pan.map { self.arcsecondsToDegrees($0.current) },
            tiltDegrees: raw.tilt.map { self.arcsecondsToDegrees($0.current) },
            zoomPercent: raw.zoom.map { $0.range.percent(of: $0.current) })
    }

    private static func angleStatus(_ axis: CameraPTZRawAxisStatus) -> CameraPTZAxisStatus {
        CameraPTZAxisStatus(
            current: self.arcsecondsToDegrees(axis.current),
            min: self.arcsecondsToDegrees(axis.range.min),
            max: self.arcsecondsToDegrees(axis.range.max),
            step: self.arcsecondsToDegrees(axis.range.step),
            default: axis.range.default.map(self.arcsecondsToDegrees),
            unit: "degrees",
            canSet: axis.canSet,
            canMove: axis.canSet)
    }

    private static func zoomStatus(_ axis: CameraPTZRawAxisStatus) -> CameraPTZAxisStatus {
        let span = Int64(axis.range.max) - Int64(axis.range.min)
        let step = span > 0 ? Double(axis.range.step) / Double(span) * 100 : 0
        return CameraPTZAxisStatus(
            current: axis.range.percent(of: axis.current),
            min: 0,
            max: 100,
            step: step,
            default: axis.range.default.map { axis.range.percent(of: $0) },
            unit: "percent",
            canSet: axis.canSet,
            canMove: axis.canSet)
    }
}

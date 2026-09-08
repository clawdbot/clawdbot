import AVFoundation
import Darwin
import Foundation
import OpenClawCameraPTZNative

struct CameraUSBIdentity: Equatable, Sendable {
    let locationId: UInt32
    let vendorId: UInt16
    let productId: UInt16

    static func parse(deviceId: String) throws -> CameraUSBIdentity {
        let trimmed = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        let hexadecimal = trimmed.hasPrefix("0x") ? String(trimmed.dropFirst(2)) : trimmed
        guard !hexadecimal.isEmpty,
              hexadecimal.count <= 16,
              let value = UInt64(hexadecimal, radix: 16)
        else {
            throw CameraPTZError.unsupported("deviceId is not a USB camera identifier")
        }
        let locationId = UInt32(truncatingIfNeeded: value >> 32)
        guard locationId != 0 else {
            throw CameraPTZError.unsupported("deviceId does not contain a USB location")
        }
        return CameraUSBIdentity(
            locationId: locationId,
            vendorId: UInt16(truncatingIfNeeded: value >> 16),
            productId: UInt16(truncatingIfNeeded: value))
    }
}

enum CameraUVCDescriptorParser {
    static func parse(_ descriptors: [UInt8]) -> (terminalId: UInt8, controls: UInt32)? {
        var terminalId: UInt8 = 1
        var controls: UInt32 = 0
        let parsed = descriptors.withUnsafeBytes { bytes in
            openclaw_uvc_parse_camera_terminal(
                bytes.bindMemory(to: UInt8.self).baseAddress,
                bytes.count,
                &terminalId,
                &controls)
        }
        return parsed == 1 ? (terminalId, controls) : nil
    }
}

enum CameraUVCControlInfo {
    private static let setCapability: UInt8 = 0x02

    static func canSet(_ info: UInt8?) -> Bool {
        info.map { $0 & self.setCapability != 0 } ?? false
    }
}

struct NativeCameraPTZBackend: CameraPTZBackend {
    func open(deviceId: String) throws -> any CameraPTZControlling {
        try NativeCameraPTZController(deviceId: deviceId)
    }

    func withCaptureSession<T>(deviceId: String, body: () throws -> T) throws -> T {
        guard let device = CameraDeviceResolver.camera(deviceId: deviceId) else {
            throw CameraPTZError.deviceNotFound(deviceId)
        }
        let session = AVCaptureSession()
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw CameraPTZError.unsupported("camera cannot start a video stream")
        }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        guard session.canAddOutput(output) else {
            throw CameraPTZError.unsupported("camera cannot provide a video stream")
        }
        session.addOutput(output)

        // UVC controls require a live video stream, which briefly lights the camera privacy indicator.
        // Without a sample-buffer delegate, video frames are neither delivered nor retained.
        session.startRunning()
        defer { session.stopRunning() }
        guard session.isRunning else {
            throw CameraPTZError.unsupported("camera video stream did not start")
        }
        return try body()
    }
}

private final class NativeCameraPTZController: CameraPTZControlling {
    private enum Control {
        static let zoomAbsolute: UInt8 = 0x0B
        static let panTiltAbsolute: UInt8 = 0x0D
    }

    private enum Request {
        static let setCurrent: UInt8 = 0x01
        static let getCurrent: UInt8 = 0x81
        static let getMin: UInt8 = 0x82
        static let getMax: UInt8 = 0x83
        static let getResolution: UInt8 = 0x84
        static let getInfo: UInt8 = 0x86
        static let getDefault: UInt8 = 0x87
    }

    private enum Capability {
        static let zoomAbsolute = UInt32(1 << 9)
        static let panTiltAbsolute = UInt32(1 << 11)
    }

    private var handle: OpaquePointer?
    private let controls: UInt32
    private var panTiltCanSet = false
    private var zoomCanSet = false

    init(deviceId: String) throws {
        let identity = try CameraUSBIdentity.parse(deviceId: deviceId)
        var handle: OpaquePointer?
        var controls: UInt32 = 0
        var error: UnsafeMutablePointer<CChar>?
        guard openclaw_uvc_open(
            identity.locationId,
            identity.vendorId,
            identity.productId,
            &handle,
            &controls,
            &error) == 1,
            let handle
        else {
            throw Self.nativeError(error, fallback: "open USB camera")
        }
        self.handle = handle
        self.controls = controls
        guard self.advertisesPanTilt || self.advertisesZoom else {
            self.close()
            throw CameraPTZError.unsupported("camera advertises no absolute PTZ axes")
        }
        self.panTiltCanSet = self.advertisesPanTilt &&
            CameraUVCControlInfo.canSet(try? self.readInfo(selector: Control.panTiltAbsolute))
        self.zoomCanSet = self.advertisesZoom &&
            CameraUVCControlInfo.canSet(try? self.readInfo(selector: Control.zoomAbsolute))
    }

    deinit {
        self.close()
    }

    func status() throws -> CameraPTZRawStatus {
        var pan: CameraPTZRawAxisStatus?
        var tilt: CameraPTZRawAxisStatus?
        var zoom: CameraPTZRawAxisStatus?
        if self.advertisesPanTilt {
            let ranges = try self.panTiltRanges()
            let current = try self.readPanTilt(request: Request.getCurrent)
            pan = CameraPTZRawAxisStatus(
                current: current.pan,
                range: ranges.pan,
                canSet: self.panTiltCanSet)
            tilt = CameraPTZRawAxisStatus(
                current: current.tilt,
                range: ranges.tilt,
                canSet: self.panTiltCanSet)
        }
        if self.advertisesZoom {
            let range = try self.zoomRange()
            zoom = try CameraPTZRawAxisStatus(
                current: self.readZoom(request: Request.getCurrent),
                range: range,
                canSet: self.zoomCanSet)
        }
        return CameraPTZRawStatus(pan: pan, tilt: tilt, zoom: zoom)
    }

    func setPanTilt(pan: Int32, tilt: Int32) throws {
        guard self.panTiltCanSet else { throw CameraPTZError.axisUnsupported("pan/tilt") }
        var bytes = Self.encodePanTilt(pan: pan, tilt: tilt)
        try self.control(selector: Control.panTiltAbsolute, request: Request.setCurrent, bytes: &bytes)
    }

    func setZoom(_ zoom: Int32) throws {
        guard self.zoomCanSet else { throw CameraPTZError.axisUnsupported("zoom") }
        var bytes = Self.encodeZoom(zoom)
        try self.control(selector: Control.zoomAbsolute, request: Request.setCurrent, bytes: &bytes)
    }

    func close() {
        guard let handle = self.handle else { return }
        openclaw_uvc_close(handle)
        self.handle = nil
    }

    private var advertisesPanTilt: Bool {
        self.controls & Capability.panTiltAbsolute != 0
    }

    private var advertisesZoom: Bool {
        self.controls & Capability.zoomAbsolute != 0
    }

    private func panTiltRanges() throws -> (pan: CameraPTZRawRange, tilt: CameraPTZRawRange) {
        let minimum = try self.readPanTilt(request: Request.getMin)
        let maximum = try self.readPanTilt(request: Request.getMax)
        let resolution = try self.readPanTilt(request: Request.getResolution)
        let defaults = try? self.readPanTilt(request: Request.getDefault)
        let pan = CameraPTZRawRange(
            min: minimum.pan,
            max: maximum.pan,
            step: resolution.pan,
            default: nil)
        let tilt = CameraPTZRawRange(
            min: minimum.tilt,
            max: maximum.tilt,
            step: resolution.tilt,
            default: nil)
        return (pan.withDefault(defaults?.pan), tilt.withDefault(defaults?.tilt))
    }

    private func zoomRange() throws -> CameraPTZRawRange {
        let minimum = try self.readZoom(request: Request.getMin)
        let maximum = try self.readZoom(request: Request.getMax)
        let resolution = try self.readZoom(request: Request.getResolution)
        let rawDefault = try? self.readZoom(request: Request.getDefault)
        return CameraPTZRawRange(
            min: minimum,
            max: maximum,
            step: resolution,
            default: nil).withDefault(rawDefault)
    }

    private func readInfo(selector: UInt8) throws -> UInt8 {
        var bytes = [UInt8](repeating: 0, count: 1)
        try self.control(selector: selector, request: Request.getInfo, bytes: &bytes)
        return bytes[0]
    }

    private func readPanTilt(request: UInt8) throws -> (pan: Int32, tilt: Int32) {
        var bytes = [UInt8](repeating: 0, count: 8)
        try self.control(selector: Control.panTiltAbsolute, request: request, bytes: &bytes)
        return (Self.decodeInt32(bytes, offset: 0), Self.decodeInt32(bytes, offset: 4))
    }

    private func readZoom(request: UInt8) throws -> Int32 {
        var bytes = [UInt8](repeating: 0, count: 2)
        try self.control(selector: Control.zoomAbsolute, request: request, bytes: &bytes)
        return Int32(UInt16(bytes[0]) | UInt16(bytes[1]) << 8)
    }

    private func control(selector: UInt8, request: UInt8, bytes: inout [UInt8]) throws {
        guard let handle = self.handle else {
            throw CameraPTZError.unsupported("controller is closed")
        }
        var error: UnsafeMutablePointer<CChar>?
        let ok = bytes.withUnsafeMutableBytes { buffer in
            openclaw_uvc_control(
                handle,
                selector,
                request,
                buffer.baseAddress,
                UInt16(buffer.count),
                &error)
        }
        guard ok == 1 else {
            throw Self.nativeError(error, fallback: "perform camera control request")
        }
    }

    private static func encodePanTilt(pan: Int32, tilt: Int32) -> [UInt8] {
        self.encodeInt32(pan) + self.encodeInt32(tilt)
    }

    private static func encodeZoom(_ zoom: Int32) -> [UInt8] {
        let value = UInt16(truncatingIfNeeded: zoom)
        return [UInt8(truncatingIfNeeded: value), UInt8(truncatingIfNeeded: value >> 8)]
    }

    private static func encodeInt32(_ value: Int32) -> [UInt8] {
        let bits = UInt32(bitPattern: value)
        return (0..<4).map { UInt8(truncatingIfNeeded: bits >> UInt32($0 * 8)) }
    }

    private static func decodeInt32(_ bytes: [UInt8], offset: Int) -> Int32 {
        var value: UInt32 = 0
        for index in 0..<4 {
            value |= UInt32(bytes[offset + index]) << UInt32(index * 8)
        }
        return Int32(bitPattern: value)
    }

    private static func nativeError(
        _ error: UnsafeMutablePointer<CChar>?,
        fallback: String) -> CameraPTZError
    {
        guard let error else { return .unsupported(fallback) }
        defer { free(error) }
        return .unsupported(String(cString: error))
    }
}

import Foundation
import simd

/// RoomBridge protocol v1 (see protocol/PROTOCOL.md). Vectors are SIMD types, which
/// Codable encodes as JSON arrays: positions `[x, y, z]`, quaternions `[x, y, z, w]`.
public enum RB {
    public static let protocolVersion = 1
}

public typealias Vec3 = SIMD3<Double>
public typealias Quat = SIMD4<Double>  // [x, y, z, w]

public enum Role: String, Codable, Sendable { case host, expert, viewer }

public enum ObjectKind: String, Codable, Sendable, CaseIterable { case pillar, partition, panel }

public enum GuidanceAxis: String, Codable, Sendable {
    case x, y, z

    public var unit: Vec3 {
        switch self {
        case .x: return Vec3(1, 0, 0)
        case .y: return Vec3(0, 1, 0)
        case .z: return Vec3(0, 0, 1)
        }
    }

    /// Colours follow Blender's axis colours for the same physical direction (COORDINATES.md).
    public var colorName: String {
        switch self {
        case .x: return "red"
        case .y: return "blue"
        case .z: return "green"
        }
    }

    public var directionName: String {
        switch self {
        case .x: return "left / right"
        case .y: return "up / down"
        case .z: return "forward / back"
        }
    }
}

public struct SceneObject: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var kind: ObjectKind
    public var name: String
    public var position: Vec3
    public var rotation: Quat
    public var dimensions: Vec3
    public var color: String
    public var textureRef: String?
    public var revision: Int
    public var originEpoch: Int
    public var stale: Bool
    public var owner: String
    public var createdBy: String
    public var updatedAt: Double
}

public struct Pose: Codable, Equatable, Sendable {
    public var position: Vec3
    public var rotation: Quat
}

public struct Attempt: Codable, Equatable, Sendable {
    public var offset: Double
    public var position: Vec3
    public var distance: Double
    public var withinTolerance: Bool
    public var holding: Bool
    public var seq: Int
    public var updatedAt: Double
}

public struct Guidance: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case preview, active, approved }
    public var id: String
    public var objectId: String
    public var state: State
    public var axis: GuidanceAxis
    public var tolerance: Double
    public var start: Pose
    public var target: Pose
    public var attempt: Attempt?
    public var originEpoch: Int

    public var targetOffset: Double { simd_dot(target.position - start.position, axis.unit) }
}

public struct Participant: Codable, Equatable, Sendable, Identifiable {
    public var clientId: String
    public var role: Role
    public var displayName: String
    public var clientKind: String
    public var connected: Bool
    public var selectedObjectId: String?
    public var id: String { clientId }
}

public struct Comment: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var objectId: String?
    public var objectName: String?
    public var authorId: String
    public var authorName: String
    public var authorRole: Role
    public var text: String
    public var createdAt: Double
    public var objectDeleted: Bool
}

public struct Reactions: Codable, Equatable, Sendable {
    public var like: [String]
    public var discuss: [String]
    public init(like: [String] = [], discuss: [String] = []) {
        self.like = like
        self.discuss = discuss
    }
}

public struct ScanMeta: Codable, Equatable, Sendable {
    public var scanId: String
    public var originEpoch: Int
    public var vertexCount: Int
    public var triangleCount: Int
    public var bytes: Int
    public var synthetic: Bool
    public var committedAt: Double
}

public struct PreviewStatus: Codable, Equatable, Sendable {
    public var state: String  // live | paused | offline
    public var hostConnected: Bool
    public var viewers: Int
    public var targetFps: Double
    public var width: Int
}

public struct RoomInfo: Codable, Equatable, Sendable {
    public var id: String
    public var code: String
    public var hostName: String
    public var originEpoch: Int
    public var sceneRevision: Int
}

public struct Snapshot: Codable, Sendable {
    public var room: RoomInfo
    public var participants: [Participant]
    public var objects: [SceneObject]
    public var guidance: Guidance?
    public var comments: [Comment]
    public var reactions: [String: Reactions]
    public var scan: ScanMeta?
    public var preview: PreviewStatus
}

public struct AuthOK: Codable, Sendable {
    public var clientId: String
    public var role: Role
    public var roomId: String
    public var code: String
    public var hostName: String
    public var previewTicket: String
}

public struct ServerError: Codable, Sendable, Error {
    public var code: String
    public var message: String
    public var ackOf: String?
}

public struct CreatedRoom: Codable, Sendable {
    public var roomId: String
    public var code: String
    public var hostToken: String
    public var expertToken: String
    public var viewerToken: String
    public var viewerLink: String
    public var expertLink: String
    public var expiresAt: Double
}

// MARK: - Envelopes

public struct Header: Decodable, Sendable {
    public var protocolVersion: Int
    public var type: String
    public var roomId: String
    public var clientId: String
    public var messageId: String
    public var sceneRevision: Int?
    public var originEpoch: Int?
    public var ackOf: String?
}

struct Envelope<P: Decodable>: Decodable {
    var payload: P
}

public struct OutgoingEnvelope<P: Encodable>: Encodable {
    public var protocolVersion = RB.protocolVersion
    public var type: String
    public var roomId: String
    public var clientId: String
    public var messageId: String
    public var originEpoch: Int?
    public var payload: P
}

/// Messages geometry is bound to; must carry the current origin epoch.
public let epochBoundTypes: Set<String> = ["object.create", "object.update", "guidance.set", "guidance.begin", "guidance.attempt"]

public enum ServerEvent: Sendable {
    case authOK(AuthOK)
    case authError(ServerError)
    case snapshot(Snapshot)
    case objectUpserted(SceneObject)
    case objectDeleted(String)
    case presence([Participant])
    case commentAdded(Comment)
    case reactionUpdated(objectId: String, Reactions)
    case guidance(Guidance?)
    case scanReady(ScanMeta)
    case previewStatus(PreviewStatus)
    case roomEnded(String)
    case ack(String)
    case error(ServerError)
    case pong
    case unknown(String)
}

public enum ProtocolDecodeError: Error, Equatable {
    case unsupportedVersion(Int)
}

public enum ServerMessageDecoder {
    struct ObjectPayload: Decodable { var object: SceneObject }
    struct IdPayload: Decodable { var id: String }
    struct PresencePayload: Decodable { var participants: [Participant] }
    struct CommentPayload: Decodable { var comment: Comment }
    struct ReactionPayload: Decodable { var objectId: String; var like: [String]; var discuss: [String] }
    struct GuidancePayload: Decodable { var guidance: Guidance? }
    struct ScanPayload: Decodable { var scan: ScanMeta }
    struct EndedPayload: Decodable { var reason: String }
    struct AckPayload: Decodable { var ackOf: String }

    public static func decode(_ data: Data) throws -> (Header, ServerEvent) {
        let dec = JSONDecoder()
        let header = try dec.decode(Header.self, from: data)
        guard header.protocolVersion == RB.protocolVersion else {
            throw ProtocolDecodeError.unsupportedVersion(header.protocolVersion)
        }
        func p<T: Decodable>(_: T.Type) throws -> T { try dec.decode(Envelope<T>.self, from: data).payload }
        let event: ServerEvent
        switch header.type {
        case "auth.ok": event = .authOK(try p(AuthOK.self))
        case "auth.error": event = .authError(try p(ServerError.self))
        case "scene.snapshot": event = .snapshot(try p(Snapshot.self))
        case "object.created", "object.updated": event = .objectUpserted(try p(ObjectPayload.self).object)
        case "object.deleted": event = .objectDeleted(try p(IdPayload.self).id)
        case "presence": event = .presence(try p(PresencePayload.self).participants)
        case "comment.added": event = .commentAdded(try p(CommentPayload.self).comment)
        case "reaction.updated":
            let r = try p(ReactionPayload.self)
            event = .reactionUpdated(objectId: r.objectId, Reactions(like: r.like, discuss: r.discuss))
        case "guidance.state": event = .guidance(try p(GuidancePayload.self).guidance)
        case "scan.ready": event = .scanReady(try p(ScanPayload.self).scan)
        case "preview.status": event = .previewStatus(try p(PreviewStatus.self))
        case "room.ended": event = .roomEnded(try p(EndedPayload.self).reason)
        case "ack": event = .ack(try p(AckPayload.self).ackOf)
        case "error": event = .error(try p(ServerError.self))
        case "pong": event = .pong
        default: event = .unknown(header.type)
        }
        return (header, event)
    }
}

public enum MessageEncoder {
    public static func encode<P: Encodable>(
        type: String, payload: P, roomId: String, clientId: String, originEpoch: Int?, messageId: String = "m-" + UUID().uuidString.lowercased()
    ) throws -> (messageId: String, data: Data) {
        let env = OutgoingEnvelope(
            type: type, roomId: roomId, clientId: clientId, messageId: messageId,
            originEpoch: epochBoundTypes.contains(type) ? originEpoch : nil, payload: payload)
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        return (messageId, try enc.encode(env))
    }
}

// MARK: - Outgoing payloads (host)

public struct AuthPayload: Encodable, Sendable {
    public var roomCode: String
    public var token: String
    public var displayName: String
    public var clientKind = "ios"
    public var resumeClientId: String?
    public init(roomCode: String, token: String, displayName: String, resumeClientId: String?) {
        self.roomCode = roomCode
        self.token = token
        self.displayName = displayName
        self.resumeClientId = resumeClientId
    }
}

public struct EmptyPayload: Encodable, Sendable { public init() {} }

public struct SelectionPayload: Encodable, Sendable {
    public var objectId: String?
    public init(objectId: String?) { self.objectId = objectId }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(objectId, forKey: .objectId)  // explicit null, not omitted
    }
    enum CodingKeys: String, CodingKey { case objectId }
}

public struct CommentPayload: Encodable, Sendable {
    public var objectId: String?
    public var text: String
    public init(objectId: String?, text: String) {
        self.objectId = objectId
        self.text = text
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(objectId, forKey: .objectId)
        try c.encode(text, forKey: .text)
    }
    enum CodingKeys: String, CodingKey { case objectId, text }
}

public struct ReactionPayload: Encodable, Sendable {
    public var objectId: String
    public var kind: String
    public init(objectId: String, kind: String) {
        self.objectId = objectId
        self.kind = kind
    }
}

public struct AttemptPayload: Encodable, Sendable {
    public var guidanceId: String
    public var offset: Double
    public var seq: Int
    public var holding: Bool
    public init(guidanceId: String, offset: Double, seq: Int, holding: Bool) {
        self.guidanceId = guidanceId
        self.offset = offset
        self.seq = seq
        self.holding = holding
    }
}

public struct GuidanceIdPayload: Encodable, Sendable {
    public var guidanceId: String
    public init(guidanceId: String) { self.guidanceId = guidanceId }
}

public struct PreviewStatusPayload: Encodable, Sendable {
    public var state: String
    public var targetFps: Double
    public var width: Int
    public init(state: String, targetFps: Double, width: Int) {
        self.state = state
        self.targetFps = targetFps
        self.width = width
    }
}

public struct OriginResetPayload: Encodable, Sendable {
    public var reason: String
    public init(reason: String) { self.reason = reason }
}

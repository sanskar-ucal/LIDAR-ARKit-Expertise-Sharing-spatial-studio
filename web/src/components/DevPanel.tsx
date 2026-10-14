import type { RoomClient } from "../client";

/** Collapsible diagnostics. Never shows the invite token or preview ticket. */
export function DevPanel({ client }: { client: RoomClient }) {
  const s = client.state;
  const f = client.frame;
  const st = client.stats;
  const latency = f ? Math.max(0, f.receivedAt - f.captureTimeMs) : null;
  return (
    <details className="card dev">
      <summary>Developer details</summary>
      <dl>
        <dt>Connection</dt>
        <dd>
          {s.connection} · preview socket {client.previewSocket}
        </dd>
        <dt>Origin epoch / revision</dt>
        <dd>
          {s.room?.originEpoch ?? "–"} / {s.room?.sceneRevision ?? "–"}
        </dd>
        <dt>Preview</dt>
        <dd>
          {s.preview ? `${s.preview.state}, ${s.preview.viewers} viewer(s), target ${s.preview.targetFps} fps @ ${s.preview.width}px` : "–"}
        </dd>
        <dt>Last frame</dt>
        <dd>
          {f
            ? `#${f.seq} ${f.width}×${f.height}, ${(f.bytes / 1024).toFixed(0)} KiB${f.synthetic ? ", SYNTHETIC" : ""}${
                latency !== null ? `, ~${Math.round(latency)} ms capture→display (clock skew possible)` : ""
              }`
            : "none"}
        </dd>
        <dt>Frames</dt>
        <dd>
          received {st.received}, shown {st.decoded}, skipped {st.skipped}, decode errors {st.decodeErrors}, last decode{" "}
          {st.lastDecodeMs.toFixed(1)} ms
        </dd>
        <dt>Room scan</dt>
        <dd>{s.scan ? `${s.scan.vertexCount} vertices, ${s.scan.triangleCount} triangles${s.scan.synthetic ? " (SIMULATED)" : ""}` : "none yet"}</dd>
        <dt>Objects</dt>
        <dd>
          {s.objects.length} ({s.objects.filter((o) => o.stale).length} stale)
        </dd>
      </dl>
    </details>
  );
}

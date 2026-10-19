import { useEffect, useRef, useState } from "react";
import type { RoomClient } from "../client";

const STALE_MS = 2000;

export function PreviewPanel({ client }: { client: RoomClient }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    client.canvas = canvas.current;
    return () => {
      client.canvas = null;
    };
  }, [client]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const s = client.state;
  const f = client.frame;
  const preview = s.preview;
  const age = f ? now - f.receivedAt : Infinity;

  let overlay: { title: string; detail: string } | null = null;
  if (s.connection === "reconnecting" || s.connection === "connecting") {
    overlay = { title: "Connecting to the room…", detail: "The preview will appear once we’re connected." };
  } else if (s.connection === "ended" || s.connection === "failed") {
    overlay = { title: "Not connected", detail: s.error ?? "" };
  } else if (!preview || preview.state === "offline" || !preview.hostConnected) {
    overlay = { title: "The phone is offline", detail: "The preview resumes when the phone user reconnects." };
  } else if (preview.state === "paused") {
    overlay = { title: "Preview paused", detail: "The phone user hasn’t shared their camera view right now." };
  } else if (!f) {
    overlay = { title: "Waiting for the first frame…", detail: "" };
  }

  return (
    <div className="preview">
      <div className="preview-frame">
        {/* Snapshots are already in the phone's interface orientation, so no rotation is applied. */}
        <canvas
          ref={canvas}
          aria-label="Live preview from the phone"
          style={{ visibility: overlay ? "hidden" : "visible" }}
        />
        {overlay && (
          <div className="preview-overlay">
            <strong>{overlay.title}</strong>
            {overlay.detail && <span>{overlay.detail}</span>}
          </div>
        )}
        {!overlay && f && (
          <div className="preview-badges">
            {f.synthetic && <span className="badge bad">SIMULATED: not a real camera</span>}
            {f.trackingLimited && <span className="badge warn">Phone tracking limited</span>}
            {age > STALE_MS && <span className="badge warn">Frozen {Math.round(age / 1000)} s: connection slow</span>}
          </div>
        )}
      </div>
      <p className="fine">
        Low-frame-rate live preview (about {preview?.targetFps ? Math.round(preview.targetFps) : "–"} fps). It may lag a little behind
        the phone; nothing is recorded.
      </p>
    </div>
  );
}

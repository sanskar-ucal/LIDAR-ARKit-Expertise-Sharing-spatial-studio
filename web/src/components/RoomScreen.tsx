import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { guidanceCaption } from "../captions";
import { RoomClient } from "../client";
import { ROLE_LABEL } from "../protocol";
import type { StoredInvite } from "../session";
import { Comments } from "./Comments";
import { DevPanel } from "./DevPanel";
import { ObjectList } from "./ObjectList";
import { Participants } from "./Participants";
import { PreviewPanel } from "./PreviewPanel";
import { RoomPlan } from "./RoomPlan";

interface Props {
  invite: StoredInvite;
  displayName: string;
  onLeave(): void;
}

function useClient(client: RoomClient): number {
  const version = useRef(0);
  return useSyncExternalStore(
    (cb) =>
      client.subscribe(() => {
        version.current += 1;
        cb();
      }),
    () => version.current,
  );
}

export function RoomScreen({ invite, displayName, onLeave }: Props) {
  const client = useMemo(() => new RoomClient({ code: invite.code, token: invite.token, displayName }), [invite, displayName]);
  useClient(client);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  const s = client.state;
  const caption = guidanceCaption(s.guidance, s.objects);
  const selectedObj = s.objects.find((o) => o.id === selected) ?? null;

  useEffect(() => {
    if (selected && !s.objects.some((o) => o.id === selected)) setSelected(null);
  }, [s.objects, selected]);

  const [toastSeq, setToastSeq] = useState(0);
  useEffect(() => {
    if (s.noticeSeq === 0) return;
    setToastSeq(s.noticeSeq);
    const t = setTimeout(() => setToastSeq(0), 4000);
    return () => clearTimeout(t);
  }, [s.noticeSeq]);

  const select = (id: string | null) => {
    setSelected(id);
    client.send("selection", { objectId: id });
  };

  return (
    <div className="room">
      <header className="topbar">
        <div className="brand">RoomBridge</div>
        <div className="room-meta">
          <span>
            Room <strong className="mono">{s.room?.code ?? invite.code}</strong>
          </span>
          {s.room && <span className="muted">hosted by {s.room.hostName}</span>}
          {s.role && <span className="tag">{ROLE_LABEL[s.role]}</span>}
        </div>
        <ConnectionBadge connection={s.connection} />
        <button className="ghost" onClick={onLeave}>
          Leave
        </button>
      </header>

      {s.error && (
        <div className={`banner ${s.connection === "failed" || s.connection === "ended" ? "bad" : "warn"}`}>
          {s.error}
          {(s.connection === "failed" || s.connection === "ended") && (
            <button className="ghost" onClick={onLeave}>
              Back
            </button>
          )}
        </div>
      )}
      {s.role === "expert" && (
        <div className="banner warn">
          You opened an <strong>expert invite</strong> in the browser. The browser is view-only; editing happens in the Blender add-on.
          Don’t share this link with family.
        </div>
      )}

      <div className="layout">
        <section className="stage">
          <PreviewPanel client={client} />
          {caption && (
            <div className={`caption ${caption.tone}`} role="status" aria-live="polite">
              <strong>{caption.title}</strong>
              <span>{caption.detail}</span>
            </div>
          )}
          <RoomPlan objects={s.objects} guidance={s.guidance} selected={selected} onSelect={select} />
        </section>
        <aside className="side">
          <Participants participants={s.participants} me={s.clientId} objects={s.objects} />
          <ObjectList
            objects={s.objects}
            reactions={s.reactions}
            comments={s.comments}
            me={s.clientId}
            selected={selected}
            guidedId={s.guidance?.objectId ?? null}
            onSelect={select}
            onReact={(objectId, kind) => client.send("reaction.toggle", { objectId, kind })}
          />
          <Comments
            comments={s.comments}
            selected={selectedObj}
            canSend={s.connection === "connected"}
            onSend={(text) => client.send("comment.add", { objectId: selected, text })}
            onClearSelection={() => select(null)}
          />
          <DevPanel client={client} />
        </aside>
      </div>
      {toastSeq > 0 && s.lastNotice && (
        <div className="toast" role="alert">
          {s.lastNotice}
        </div>
      )}
    </div>
  );
}

function ConnectionBadge({ connection }: { connection: string }) {
  const map: Record<string, [string, string]> = {
    connecting: ["Connecting…", "warn"],
    connected: ["Connected", "good"],
    reconnecting: ["Reconnecting…", "warn"],
    failed: ["Not connected", "bad"],
    ended: ["Room ended", "bad"],
  };
  const [label, tone] = map[connection] ?? ["", "warn"];
  return <span className={`badge ${tone}`}>{label}</span>;
}

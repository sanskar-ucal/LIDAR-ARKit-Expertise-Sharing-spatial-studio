import { useState, type FormEvent } from "react";
import { parseInvite } from "../protocol";
import type { StoredInvite } from "../session";

interface Props {
  invite: StoredInvite | null;
  name: string;
  onJoin(invite: StoredInvite, name: string): void;
}

export function JoinScreen({ invite, name: initialName, onJoin }: Props) {
  const [name, setName] = useState(initialName);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError("Please enter your name so the others know who is watching.");
    const inv = invite ?? parseInvite(link);
    if (!inv) return setError("That doesn’t look like a RoomBridge invite link. Ask the phone user to share it again.");
    setError(null);
    onJoin(inv, n.slice(0, 40));
  };

  return (
    <main className="join">
      <form className="card join-card" onSubmit={submit}>
        <h1>RoomBridge</h1>
        {invite ? (
          <p className="lead">
            You’re invited to watch room <strong className="mono">{invite.code}</strong>. You’ll see the phone’s live preview
            and the objects the expert places, and you can leave comments.
          </p>
        ) : (
          <>
            <p className="lead">Paste the invite link the phone user shared with you.</p>
            <label>
              Invite link
              <input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="http://10.0.0.61:8787/r/ABC123#t=…"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </>
        )}
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Grandma" autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary">
          Join room
        </button>
        <p className="fine">Nothing is recorded. The preview only appears while the phone user chooses to share it.</p>
      </form>
    </main>
  );
}

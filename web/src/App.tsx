import { useState } from "react";
import { JoinScreen } from "./components/JoinScreen";
import { RoomScreen } from "./components/RoomScreen";
import { forgetInvite, loadName, saveName, storeInvite, takeInviteFromLocation, type StoredInvite } from "./session";

export function App() {
  const [invite, setInvite] = useState<StoredInvite | null>(() =>
    takeInviteFromLocation(window.location, window.sessionStorage, window.history),
  );
  const [name, setName] = useState(() => loadName(window.localStorage));
  const [joined, setJoined] = useState<{ invite: StoredInvite; name: string } | null>(null);

  if (joined) {
    return (
      <RoomScreen
        key={`${joined.invite.code}:${joined.name}`}
        invite={joined.invite}
        displayName={joined.name}
        onLeave={() => {
          forgetInvite(window.sessionStorage);
          window.history.replaceState(null, "", "/");
          setJoined(null);
          setInvite(null);
        }}
      />
    );
  }

  return (
    <JoinScreen
      invite={invite}
      name={name}
      onJoin={(inv, displayName) => {
        storeInvite(inv, window.sessionStorage);
        saveName(displayName, window.localStorage);
        window.history.replaceState(null, "", `/r/${inv.code}`);
        setName(displayName);
        setInvite(inv);
        setJoined({ invite: inv, name: displayName });
      }}
    />
  );
}

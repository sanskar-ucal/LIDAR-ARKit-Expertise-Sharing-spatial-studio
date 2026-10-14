import { parseInvite } from "./protocol";

const KEY = "roombridge.invite";

export interface StoredInvite {
  code: string;
  token: string;
}

/**
 * Reads an invite from the current URL fragment (never sent to the server in HTTP
 * requests), keeps it in sessionStorage for reloads in this tab only, and removes the
 * token from the address bar so it does not end up in screenshots or history.
 */
export function takeInviteFromLocation(loc: Location, storage: Storage, history: History): StoredInvite | null {
  const fromUrl = parseInvite(loc.href);
  if (fromUrl) {
    storage.setItem(KEY, JSON.stringify(fromUrl));
    history.replaceState(null, "", `/r/${fromUrl.code}`);
    return fromUrl;
  }
  const m = /^\/r\/([A-Za-z0-9]{4,12})\/?$/.exec(loc.pathname);
  const raw = storage.getItem(KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as StoredInvite;
    if (m && saved.code !== m[1]!.toUpperCase()) return null;
    return saved;
  } catch {
    return null;
  }
}

export function storeInvite(invite: StoredInvite, storage: Storage): void {
  storage.setItem(KEY, JSON.stringify(invite));
}

export function forgetInvite(storage: Storage): void {
  storage.removeItem(KEY);
}

export function loadName(storage: Storage): string {
  return storage.getItem("roombridge.name") ?? "";
}

export function saveName(name: string, storage: Storage): void {
  storage.setItem("roombridge.name", name);
}

// Per-project graph node position cache backed by localStorage.
//
// P2 feature: the saved {id:{x,y}} map is used as an *initial-position seed*
// only (never as fx/fy pins) so the graph starts from a good layout instead of
// an origin big-bang. This module just persists/loads — the pinning policy is
// the caller's concern.
//
// Every localStorage access + JSON parse/stringify is wrapped in try/catch so
// quota errors, corrupt data, or an absent `localStorage` degrade gracefully:
//   - savePositions → no-op
//   - loadPositions → null

type Pos = { x: number; y: number };
type PosMap = Record<string, Pos>;

// Layout v3 starts from the compact semantic-force configuration.
const keyFor = (project: string): string => `svx.pos.v3.${project}`;

function getStorage(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    return ls ?? null;
  } catch {
    // Accessing localStorage can throw (e.g. sandboxed/blocked contexts).
    return null;
  }
}

export function loadPositions(project: string): PosMap | null {
  const ls = getStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(keyFor(project));
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== 'object') return null;
    return parsed as PosMap;
  } catch {
    // Corrupt JSON or any storage read error → treat as no cache.
    return null;
  }
}

export function savePositions(
  project: string,
  nodes: { id: string; x?: number; y?: number }[],
): void {
  const ls = getStorage();
  if (!ls) return;
  try {
    const map: PosMap = {};
    for (const n of nodes) {
      if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
        map[n.id] = { x: n.x as number, y: n.y as number };
      }
    }
    ls.setItem(keyFor(project), JSON.stringify(map));
  } catch {
    // Quota exceeded / serialization / storage write error → no-op.
  }
}

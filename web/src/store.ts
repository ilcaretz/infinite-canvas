import type { Item, UploadInfo } from './types';

// Board store with an undo stack. Step 2: sync.ts mirrors it to the server (autosave + polling);
// the public methods (addItems / commit / deleteItems / reorder / undo / redo) are the seam.

export type ItemMap = Record<string, Item>;
/** id -> item state, or null = "does not exist". */
export type Snap = Record<string, Item | null>;

interface Entry { label: string; before: Snap; after: Snap }

export interface BoardState {
  boardId: string;
  boardName: string;
  items: ItemMap;
  selection: ReadonlySet<string>;
  /** Transient upload / processing state per item id (not saved, not in undo). */
  uploads: Record<string, UploadInfo>;
  /** Last autosave failed (shown as a small warning). */
  saveError: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_HISTORY = 500;

const sameGeometry = (a: Item | null, b: Item | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.z === b.z
    && a.props === b.props && a.name === b.name);

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};

export class BoardStore {
  private s: BoardState = {
    boardId: 'local',
    boardName: 'Untitled board',
    items: {},
    selection: new Set(),
    uploads: {},
    saveError: false,
    canUndo: false,
    canRedo: false,
  };
  private listeners = new Set<() => void>();
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  /** Items being dragged / resized right now: remote merges must not touch them. */
  private transient = new Set<string>();

  isTransient = (id: string) => this.transient.has(id);

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };

  getState = () => this.s;

  private set(patch: Partial<BoardState>) {
    this.s = { ...this.s, ...patch, canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
    this.listeners.forEach((l) => l());
  }

  private push(e: Entry) {
    this.undoStack.push(e);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private maxZ() {
    let m = 0;
    for (const id in this.s.items) m = Math.max(m, this.s.items[id].z);
    return m;
  }

  private minZ() {
    let m = 0;
    for (const id in this.s.items) m = Math.min(m, this.s.items[id].z);
    return m;
  }

  // ---- items -------------------------------------------------------------

  /** Add items on top of the stack (z assigned here) as ONE undo step; selects them. */
  addItems(list: Item[]) {
    if (!list.length) return;
    let z = this.maxZ();
    const now = Date.now();
    const items = { ...this.s.items };
    const before: Snap = {};
    const after: Snap = {};
    for (const it of list) {
      z += 1;
      const n: Item = { ...it, z, version: 1, updatedAt: now };
      items[n.id] = n;
      before[n.id] = null;
      after[n.id] = n;
    }
    this.push({ label: 'add', before, after });
    this.set({ items, selection: new Set(list.map((i) => i.id)) });
  }

  snapshot(ids: Iterable<string>): Record<string, Item> {
    const out: Record<string, Item> = {};
    for (const id of ids) if (this.s.items[id]) out[id] = this.s.items[id];
    return out;
  }

  /** Live (drag) update, not recorded in history. Finish with commit(). */
  transientPatch(patches: Record<string, Partial<Item>>) {
    const items = { ...this.s.items };
    for (const id in patches) {
      if (!items[id]) continue;
      items[id] = { ...items[id], ...patches[id] };
      this.transient.add(id);
    }
    this.set({ items });
  }

  /** Record one undo step for `before` -> current state (no-op when nothing changed). */
  commit(label: string, before: Snap) {
    for (const id in before) this.transient.delete(id);
    const after: Snap = {};
    let changed = false;
    for (const id in before) {
      const cur = this.s.items[id] ?? null;
      after[id] = cur;
      if (!sameGeometry(before[id], cur)) changed = true;
    }
    if (!changed) return;
    const now = Date.now();
    const items = { ...this.s.items };
    for (const id in after) {
      const cur = after[id];
      if (cur) {
        const bumped = { ...cur, version: cur.version + 1, updatedAt: now };
        items[id] = bumped;
        after[id] = bumped;
      }
    }
    this.push({ label, before, after });
    this.set({ items });
  }

  /** One undoable edit of arbitrary fields (text content, style, colour, title...): patch, then commit. */
  edit(label: string, patches: Record<string, Partial<Item>>) {
    const before = this.snapshot(Object.keys(patches));
    this.transientPatch(patches);
    this.commit(label, before);
  }

  /**
   * Drop an item that was just created and never got content (empty new text): when the add is still the last
   * undo step it is taken back entirely, else it is an ordinary delete.
   */
  discardNew(id: string) {
    const last = this.undoStack[this.undoStack.length - 1];
    const keys = last ? Object.keys(last.after) : [];
    if (last?.label === 'add' && keys.length === 1 && keys[0] === id) {
      this.undoStack.pop();
      const items = { ...this.s.items };
      delete items[id];
      this.transient.delete(id);
      this.set({ items, selection: new Set([...this.s.selection].filter((x) => items[x])) });
    } else this.deleteItems([id]);
  }

  deleteItems(ids: Iterable<string>) {
    const before: Snap = {};
    const after: Snap = {};
    const items = { ...this.s.items };
    for (const id of ids) {
      if (!items[id]) continue;
      before[id] = items[id];
      after[id] = null;
      delete items[id];
    }
    if (!Object.keys(before).length) return;
    const selection = new Set([...this.s.selection].filter((id) => items[id]));
    this.push({ label: 'delete', before, after });
    this.set({ items, selection });
  }

  /** Bring to front / send to back, keeping the relative order of the given items. */
  reorder(ids: Iterable<string>, toFront: boolean) {
    const chosen = new Set<string>();
    for (const id of ids) if (this.s.items[id]) chosen.add(id);
    if (!chosen.size) return;
    const list = [...chosen].map((id) => this.s.items[id]).sort((a, b) => a.z - b.z);
    let othersMax = -Infinity;
    let othersMin = Infinity;
    for (const id in this.s.items) {
      if (chosen.has(id)) continue;
      othersMax = Math.max(othersMax, this.s.items[id].z);
      othersMin = Math.min(othersMin, this.s.items[id].z);
    }
    if (toFront && list[0].z > othersMax) return;
    if (!toFront && list[list.length - 1].z < othersMin) return;
    const base = toFront ? this.maxZ() + 1 : this.minZ() - list.length;
    const before: Snap = {};
    const after: Snap = {};
    const items = { ...this.s.items };
    const now = Date.now();
    list.forEach((it, i) => {
      const n = { ...it, z: base + i, version: it.version + 1, updatedAt: now };
      before[it.id] = it;
      after[it.id] = n;
      items[it.id] = n;
    });
    this.push({ label: toFront ? 'front' : 'back', before, after });
    this.set({ items });
  }

  // ---- history -----------------------------------------------------------

  /** Undo/redo restore old values but with a NEW version/updatedAt, so they count as fresh edits (saved, win merges). */
  private applySnap(snap: Snap): ItemMap {
    const items = { ...this.s.items };
    const now = Date.now();
    for (const id in snap) {
      const v = snap[id];
      if (v) items[id] = { ...v, version: Math.max(items[id]?.version ?? 0, v.version) + 1, updatedAt: now };
      else delete items[id];
    }
    return items;
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    const items = this.applySnap(e.before);
    this.set({ items, selection: new Set(Object.keys(e.before).filter((id) => items[id])) });
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    const items = this.applySnap(e.after);
    this.set({ items, selection: new Set(Object.keys(e.after).filter((id) => items[id])) });
  }

  /**
   * Silent correction (e.g. real aspect ratio once media metadata is known). Applied to the live item AND
   * to every history snapshot of it, so undo/redo never brings back the provisional size.
   */
  patchEverywhere(id: string, fn: (it: Item) => Item) {
    const items = { ...this.s.items };
    if (items[id]) items[id] = fn(items[id]);
    for (const e of [...this.undoStack, ...this.redoStack]) {
      for (const snap of [e.before, e.after]) {
        const v = snap[id];
        if (v) snap[id] = fn(v);
      }
    }
    this.set({ items });
  }

  // ---- server sync (step 2) ----------------------------------------------

  /** Replace the whole board (initial load). Clears history and selection. */
  loadBoard(boardId: string, boardName: string, items: Item[]) {
    this.undoStack = [];
    this.redoStack = [];
    this.transient.clear();
    const map: ItemMap = {};
    for (const it of items) map[it.id] = it;
    this.set({ boardId, boardName, items: map, selection: new Set(), uploads: {}, saveError: false });
  }

  setBoardName(name: string) {
    this.set({ boardName: name });
  }

  setSaveError(saveError: boolean) {
    if (saveError !== this.s.saveError) this.set({ saveError });
  }

  /** Transient upload state for one item (null clears it). Does not touch history. */
  setUpload(id: string, info: UploadInfo | null) {
    const uploads = { ...this.s.uploads };
    if (info) uploads[id] = info;
    else delete uploads[id];
    this.set({ uploads });
  }

  /** Merge changes that came from the server (another tab). Not recorded in history. */
  applyRemote(upserts: Item[], removeIds: string[]) {
    const items = { ...this.s.items };
    for (const u of upserts) items[u.id] = { ...u, src: items[u.id]?.src ?? null };
    for (const id of removeIds) delete items[id];
    const selection = new Set([...this.s.selection].filter((id) => items[id]));
    this.set({ items, selection });
  }

  // ---- selection ---------------------------------------------------------

  setSelection(ids: Iterable<string>) {
    const next = new Set([...ids].filter((id) => this.s.items[id]));
    if (sameSet(next, this.s.selection)) return;
    this.set({ selection: next });
  }

  toggleSelection(id: string) {
    const next = new Set(this.s.selection);
    if (next.has(id)) next.delete(id);
    else if (this.s.items[id]) next.add(id);
    this.set({ selection: next });
  }

  clearSelection() {
    this.setSelection([]);
  }

  selectAll() {
    this.setSelection(Object.keys(this.s.items));
  }
}

export const boardStore = new BoardStore();

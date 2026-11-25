import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type DragEvent as RDragEvent, type PointerEvent as RPointerEvent,
} from 'react';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { createClickGate } from './clickGate';
import { InfoPanel, RowsPanel } from './InfoPanel';
import { seekBoardAudio, toggleBoardMedia } from './audioControl';
import { boardVideo, stepVideoElement } from './videoStep';
import { Viewer } from './Viewer';
import { isViewable } from './viewerLogic';
import { createItemsFromFiles, createItemsFromUrls, DROP_CELL, DROP_GAP, extractDroppedUrls, newId } from './files';
import {
  GROUP_DEFAULT, defaultGroupRect, groupContents, groupProps, groupRectFromSelection, groupRenderOrder, moveSet, resizeGroup, titleRect,
} from './groupLogic';
import { TEXT_DEFAULT, TEXT_DEFAULT_W, estimateTextHeight, resizeText, textName, textProps } from './textLogic';
import { TextToolbar } from './TextToolbar';
import {
  boundsOf, fitBounds, gridLayout, normalizeWheelDelta, rectFromPoints, rectsIntersect, resizeBox,
  scaleRectInBox, screenToWorld, wheelZoomFactor, zoomAt,
  type Camera, type Handle, type Rect, type Vec,
} from './geometry';
import { ItemView } from './ItemView';
import { toggleRealSize } from './realSize';
import { boardStore } from './store';
import { TopBar } from './TopBar';
import type { Item } from './types';
import { replaceWithFile } from './uploads';
import { api } from './api';
import { copyWorkflow, getConfig, openInComfy } from './comfy';
import { isCloudConfig } from './cloud/mode';
import { toast, ToastHost } from './Toast';

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_POS: Record<Handle, [string, string]> = {
  nw: ['0%', '0%'], n: ['50%', '0%'], ne: ['100%', '0%'], e: ['100%', '50%'],
  se: ['100%', '100%'], s: ['50%', '100%'], sw: ['0%', '100%'], w: ['0%', '50%'],
};
const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};
/** Level of detail from the item's on-screen size: thumb below ~600 px, full above (450-600 keeps the current one). */
const lodOf = (px: number): 0 | 1 | 2 => (px >= 600 ? 2 : px >= 450 ? 1 : 0);
const CLICK_SLOP = 3; // screen px before a press becomes a drag
const MAX_GHOSTS = 60;
/** Previous rect per item, remembered by the double-click real-size toggle (client memory only). */
const prevRects = new Map<string, { x: number; y: number; w: number; h: number }>();

type Drag =
  | { type: 'pan'; pointerId: number; start: Vec; camX: number; camY: number }
  | { type: 'move'; pointerId: number; start: Vec; before: Record<string, Item>; moved: boolean; collapseTo: string | null; videoId: string | null }
  | { type: 'marquee'; pointerId: number; start: Vec; base: Set<string>; additive: boolean; moved: boolean }
  | { type: 'resize'; pointerId: number; handle: Handle; start: Vec; box: Rect; before: Record<string, Item> };

interface MenuState { x: number; y: number; itemId: string | null; world: Vec }

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

const hasFiles = (e: { dataTransfer: DataTransfer | null }) =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

/** Files from Explorer, or an image / video / link dragged out of another browser tab. */
const hasDroppable = (e: { dataTransfer: DataTransfer | null }) => {
  if (!e.dataTransfer) return false;
  const t = Array.from(e.dataTransfer.types);
  return t.includes('Files') || t.includes('text/uri-list') || t.includes('text/html');
};

/** Paste from the system clipboard (menu item): images only, since browsers do not hand out copied Explorer files. */
async function pasteFromClipboard(at: Vec) {
  if (!navigator.clipboard?.read) {
    toast('This browser cannot read the clipboard from a menu. Press Ctrl+V on the board instead.');
    return;
  }
  try {
    const files: File[] = [];
    for (const ci of await navigator.clipboard.read()) {
      const type = ci.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await ci.getType(type);
      files.push(new File([blob], `pasted.${type.split('/')[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg')}`, { type }));
    }
    if (files.length) createItemsFromFiles(files, at);
    else toast('No image on the clipboard. For files, drag them in or press Ctrl+V on the board.');
  } catch {
    toast("Can't read the clipboard here (permission denied). Press Ctrl+V on the board instead.");
  }
}

function downloadOriginal(id: string) {
  const a = document.createElement('a');
  a.href = `/api/items/${id}/original`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const CAM_KEY = (boardId: string) => `board.cam.${boardId}`;
function loadCam(boardId: string): Camera | null {
  try {
    const v = JSON.parse(localStorage.getItem(CAM_KEY(boardId)) ?? 'null');
    if (v && [v.x, v.y, v.z].every((n: unknown) => typeof n === 'number' && isFinite(n as number))) return v as Camera;
  } catch {
    /* ignore */
  }
  return null;
}

export default function App() {
  const state = useSyncExternalStore(boardStore.subscribe, boardStore.getState);

  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  const camSaveTimer = useRef(0);
  const [cam, setCamState] = useState<Camera>({ x: 0, y: 0, z: 1 });
  const camRef = useRef(cam);
  const rafRef = useRef(0);
  const sizeRef = useRef({ w: window.innerWidth, h: window.innerHeight });
  const [size, setSize] = useState(sizeRef.current);

  const dragRef = useRef<Drag | null>(null);
  const spaceRef = useRef(false);
  const lastPtr = useRef<Vec | null>(null); // screen coords relative to the board
  const pickOrigin = useRef<Vec | null>(null); // world point for the next file-picker result
  const dragDepth = useRef(0);
  const menuRef = useRef<MenuState | null>(null);

  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drop, setDrop] = useState<{ count: number; at: Vec } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoOpenRef = useRef(false);
  infoOpenRef.current = infoOpen;
  // A click on a board video / audio card toggles play after a short delay; a double click (real-size toggle) cancels it.
  const [videoGate] = useState(() => createClickGate<string>(toggleBoardMedia));
  const [viewerId, setViewerId] = useState<string | null>(null);
  const viewerRef = useRef<string | null>(null);
  viewerRef.current = viewerId;
  const openViewer = useCallback((id: string) => {
    if (isViewable(boardStore.getState().items[id])) setViewerId(id);
  }, []);
  const closeViewer = useCallback(() => setViewerId(null), []);
  menuRef.current = menu;

  // Camera updates are coalesced to one React render per frame; camRef is always the latest value.
  const setCamera = useCallback((c: Camera) => {
    camRef.current = c;
    window.clearTimeout(camSaveTimer.current);
    camSaveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(CAM_KEY(boardStore.getState().boardId), JSON.stringify(camRef.current));
      } catch {
        /* storage unavailable: the camera just is not remembered */
      }
    }, 300);
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        setCamState(camRef.current);
      });
    }
  }, []);

  const toLocal = useCallback((e: { clientX: number; clientY: number }): Vec => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const viewportCenterWorld = useCallback((): Vec =>
    screenToWorld({ x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 }, camRef.current), []);

  const cursorWorld = useCallback((): Vec =>
    lastPtr.current ? screenToWorld(lastPtr.current, camRef.current) : viewportCenterWorld(), [viewportCenterWorld]);

  const fitAll = useCallback(() => {
    const items = Object.values(boardStore.getState().items);
    const b = boundsOf(items);
    setCamera(b
      ? fitBounds(b, sizeRef.current, 80, 1)
      : { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2, z: 1 });
  }, [setCamera]);

  const zoom100 = useCallback(() => {
    setCamera(zoomAt(camRef.current, { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 }, 1));
  }, [setCamera]);

  const openPicker = useCallback((worldPoint: Vec | null) => {
    pickOrigin.current = worldPoint;
    fileInputRef.current?.click();
  }, []);

  // ---- mount: size, centered camera ----------------------------------------
  useLayoutEffect(() => {
    const root = rootRef.current!;
    const measure = () => {
      const r = root.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      setSize({ w: r.width, h: r.height });
    };
    measure();
    // Camera per board: restore the saved one, else fit what is on the board, else center the origin.
    const st = boardStore.getState();
    const boxed = boundsOf(Object.values(st.items));
    const c = loadCam(st.boardId)
      ?? (boxed ? fitBounds(boxed, sizeRef.current, 80, 1) : { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2, z: 1 });
    camRef.current = c;
    setCamState(c);
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  // ---- native listeners: wheel (non-passive), middle-click suppression, DnD guards ----
  useEffect(() => {
    const root = rootRef.current!;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // never scroll, never browser-zoom (also covers ctrl+wheel pinch)
      const r = root.getBoundingClientRect();
      const dy = normalizeWheelDelta(e.deltaY, e.deltaMode, r.height);
      if (dy === 0) return;
      const cam = camRef.current;
      setCamera(zoomAt(cam, { x: e.clientX - r.left, y: e.clientY - r.top }, cam.z * wheelZoomFactor(dy)));
    };
    root.addEventListener('wheel', onWheel, { passive: false });

    // Suppress browser middle-click autoscroll, and text selection / native drag on left press.
    const onMouseDown = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('.text-edit, .group-rename')) return; // in-place editors: caret + text selection must work
      if (e.button === 1 || e.button === 0) e.preventDefault();
    };
    const onAuxClick = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    root.addEventListener('mousedown', onMouseDown);
    root.addEventListener('auxclick', onAuxClick);

    // Window level: no page zoom from ctrl+wheel anywhere, wheel closes the context menu,
    // and a file dropped outside the board must never navigate the tab to the file.
    const onWinWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
      if (menuRef.current) setMenu(null);
    };
    const stopFileNav = (e: Event) => {
      if (hasDroppable(e as globalThis.DragEvent)) e.preventDefault();
    };
    window.addEventListener('wheel', onWinWheel, { passive: false });
    window.addEventListener('dragover', stopFileNav);
    window.addEventListener('drop', stopFileNav);
    return () => {
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('mousedown', onMouseDown);
      root.removeEventListener('auxclick', onAuxClick);
      window.removeEventListener('wheel', onWinWheel);
      window.removeEventListener('dragover', stopFileNav);
      window.removeEventListener('drop', stopFileNav);
    };
  }, [setCamera]);

  // ---- text + group items, duplicate -------------------------------------------------------------
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingRef = useRef<string | null>(null);
  editingRef.current = editingId;

  const blankItem = (kind: 'text' | 'group', r: { x: number; y: number; w: number; h: number }, name: string, props: unknown): Item => ({
    id: newId(), kind, x: r.x, y: r.y, w: r.w, h: r.h, z: 0, version: 1, updatedAt: Date.now(),
    name, ext: '', mime: '', sizeBytes: 0, src: null, durationMs: null, props,
  });

  /** New text item at `at` (its top-left), straight into edit mode. */
  const createText = useCallback((at: Vec) => {
    const it = blankItem('text', { x: at.x, y: at.y, w: TEXT_DEFAULT_W, h: estimateTextHeight('', TEXT_DEFAULT.size) }, '', { ...TEXT_DEFAULT });
    boardStore.addItems([it]);
    setEditingId(it.id);
  }, []);

  /** Group around the selection (bbox + padding + title bar), or a 600x400 one at `at`. */
  const createGroup = useCallback((at: Vec) => {
    const st = boardStore.getState();
    const sel = [...st.selection].map((id) => st.items[id]).filter(Boolean);
    const r = groupRectFromSelection(sel) ?? defaultGroupRect(at);
    boardStore.addItems([blankItem('group', r, GROUP_DEFAULT.title, { ...GROUP_DEFAULT })]);
  }, []);

  /** Esc / Enter / blur on a text or group title editor. */
  const onEditDone = useCallback((id: string, value: string) => {
    setEditingId((cur) => (cur === id ? null : cur));
    const it = boardStore.getState().items[id];
    if (!it) return;
    if (it.kind === 'text') {
      if (value === '' ) {
        boardStore.discardNew(id); // empty text on commit: the item goes away
        return;
      }
      if (value !== textProps(it.props).text) {
        boardStore.edit('text', { [id]: { props: { ...textProps(it.props), text: value }, name: textName(value) } });
      }
    } else if (it.kind === 'group') {
      const title = value.trim() || groupProps(it.props).title;
      if (title !== groupProps(it.props).title) {
        boardStore.edit('rename', { [id]: { props: { ...groupProps(it.props), title }, name: title } });
      }
    }
  }, []);

  /** Ctrl/Cmd+D: copies of the selection, offset 24 px, selected afterwards. Files still uploading are skipped. */
  const duplicateSelection = useCallback(() => {
    const st = boardStore.getState();
    const copies: Item[] = [];
    for (const id of st.selection) {
      const it = st.items[id];
      if (!it || (it.kind !== 'text' && it.kind !== 'group' && !it.mediaId)) continue;
      copies.push({ ...it, id: newId(), x: it.x + 24, y: it.y + 24, version: 1, updatedAt: Date.now() });
    }
    boardStore.addItems(copies);
  }, []);

  // ---- keyboard + paste ----------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || viewerRef.current) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const busy = dragRef.current !== null;

      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) {
          spaceRef.current = true;
          setSpaceHeld(true);
        }
      } else if (e.key === 'Escape') {
        if (menuRef.current) setMenu(null);
        else if (infoOpenRef.current) setInfoOpen(false);
        else boardStore.clearSelection();
      } else if (ctrl && !e.altKey && !e.shiftKey && k === 'd') {
        e.preventDefault();
        if (!busy) duplicateSelection();
      } else if (!ctrl && !e.altKey && !e.shiftKey && k === 'i') {
        e.preventDefault();
        setInfoOpen((o) => !o);
      } else if (!ctrl && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const st = boardStore.getState();
        const sel = [...st.selection];
        const it = sel.length === 1 ? st.items[sel[0]] : undefined;
        const v = it?.kind === 'video' ? boardVideo(it.id) : null;
        if (it && v) {
          e.preventDefault();
          stepVideoElement(v, it.fps, (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
        } else if (it?.kind === 'audio') {
          // audio card: seek 1 s (Shift 5 s)
          if (seekBoardAudio(it.id, (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1))) e.preventDefault();
        }
      } else if (e.key === 'Enter' && !ctrl && !e.shiftKey) {
        const sel = [...boardStore.getState().selection];
        const one = sel.length === 1 ? boardStore.getState().items[sel[0]] : undefined;
        if (one?.kind === 'text') {
          e.preventDefault();
          setEditingId(one.id);
        } else if (one && isViewable(one)) {
          e.preventDefault();
          setViewerId(one.id);
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (!busy) boardStore.deleteItems([...boardStore.getState().selection]);
      } else if (ctrl && k === 'z') {
        e.preventDefault();
        if (busy) return;
        if (e.shiftKey) boardStore.redo();
        else boardStore.undo();
      } else if (ctrl && k === 'y') {
        e.preventDefault();
        if (!busy) boardStore.redo();
      } else if (ctrl && k === 'a') {
        e.preventDefault();
        boardStore.selectAll();
      } else if (e.shiftKey && !ctrl && e.code === 'Digit1') {
        e.preventDefault();
        fitAll();
      } else if (e.shiftKey && !ctrl && e.code === 'Digit0') {
        e.preventDefault();
        zoom100();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        if (!isTyping(e.target)) e.preventDefault(); // stop Space from "clicking" a focused button
        spaceRef.current = false;
        setSpaceHeld(false);
      }
    };
    const onBlur = () => {
      spaceRef.current = false;
      setSpaceHeld(false);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      createItemsFromFiles(files, cursorWorld());
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('paste', onPaste);
    };
  }, [fitAll, zoom100, cursorWorld, duplicateSelection]);

  // Context menu: close on outside press.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.('.ctx-menu')) setMenu(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', () => setMenu(null), { once: true });
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [menu]);

  // ---- pointer interaction -------------------------------------------------------------
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return;
    if ((e.target as HTMLElement).closest('[data-nodrag]')) return; // buttons inside items (retry, download...)
    (document.activeElement as HTMLElement | null)?.blur?.();
    const p = toLocal(e);
    lastPtr.current = p;
    const root = e.currentTarget;

    // Pan: middle button, or Space + left.
    if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
      dragRef.current = { type: 'pan', pointerId: e.pointerId, start: p, camX: camRef.current.x, camY: camRef.current.y };
      root.setPointerCapture(e.pointerId);
      setPanning(true);
      return;
    }
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    const mod = e.shiftKey || e.ctrlKey || e.metaKey;

    // Resize handle.
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle') as Handle | null;
    if (handle) {
      const st = boardStore.getState();
      const before = boardStore.snapshot(st.selection);
      const box = boundsOf(Object.values(before));
      if (!box) return;
      dragRef.current = { type: 'resize', pointerId: e.pointerId, handle, start: p, box, before };
      root.setPointerCapture(e.pointerId);
      return;
    }

    // Item: select, then maybe move.
    const itemId = target.closest('[data-item-id]')?.getAttribute('data-item-id');
    if (itemId) {
      const wasSelected = boardStore.getState().selection.has(itemId);
      if (mod) boardStore.toggleSelection(itemId);
      else if (!wasSelected) boardStore.setSelection([itemId]);
      const sel = boardStore.getState().selection;
      if (!sel.has(itemId)) return; // toggled off: nothing to drag
      const cur = boardStore.getState().items;
      dragRef.current = {
        // a group drags everything fully inside it (frozen now, at drag start), nested groups included
        type: 'move', pointerId: e.pointerId, start: p, before: boardStore.snapshot(moveSet(sel, cur)), moved: false,
        // plain click on an already-selected item inside a multi-selection collapses to it on release
        collapseTo: !mod && wasSelected && sel.size > 1 ? itemId : null,
        videoId: !mod && ['video', 'audio'].includes(boardStore.getState().items[itemId]?.kind ?? '') ? itemId : null,
      };
      root.setPointerCapture(e.pointerId);
      return;
    }

    // Empty space: marquee (click without drag = deselect).
    dragRef.current = {
      type: 'marquee', pointerId: e.pointerId, start: p, additive: mod, moved: false,
      base: new Set(mod ? boardStore.getState().selection : []),
    };
    root.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = toLocal(e);
    lastPtr.current = p;
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const cam = camRef.current;

    switch (d.type) {
      case 'pan':
        setCamera({ x: d.camX + (p.x - d.start.x), y: d.camY + (p.y - d.start.y), z: cam.z });
        break;
      case 'move': {
        if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < CLICK_SLOP) return;
        d.moved = true;
        const dx = (p.x - d.start.x) / cam.z;
        const dy = (p.y - d.start.y) / cam.z;
        const patches: Record<string, Partial<Item>> = {};
        for (const id in d.before) patches[id] = { x: d.before[id].x + dx, y: d.before[id].y + dy };
        boardStore.transientPatch(patches);
        break;
      }
      case 'resize': {
        const dx = (p.x - d.start.x) / cam.z;
        const dy = (p.y - d.start.y) / cam.z;
        const only = Object.values(d.before);
        if (only.length === 1 && only[0].kind === 'text') {
          // text: the handles change the box width (text wraps); Shift on a corner scales the font
          const t = only[0];
          const r = resizeText(d.box, textProps(t.props).size, d.handle, dx, dy, e.shiftKey);
          boardStore.transientPatch({
            [t.id]: { x: r.rect.x, y: r.rect.y, w: r.rect.w, h: r.rect.h, props: { ...textProps(t.props), size: r.size } },
          });
          break;
        }
        if (only.length === 1 && only[0].kind === 'group') {
          // group: freeform (no aspect lock), side handles move one edge only; contents never move
          const g = resizeGroup(d.box, d.handle, dx, dy);
          boardStore.transientPatch({ [only[0].id]: { x: g.x, y: g.y, w: g.w, h: g.h } });
          break;
        }
        const nb = resizeBox(d.box, d.handle, dx, dy, !e.shiftKey); // Shift = free
        const patches: Record<string, Partial<Item>> = {};
        for (const id in d.before) {
          const it = d.before[id];
          const r = scaleRectInBox({ x: it.x, y: it.y, w: it.w, h: it.h }, d.box, nb);
          patches[id] = { x: r.x, y: r.y, w: r.w, h: r.h };
        }
        boardStore.transientPatch(patches);
        break;
      }
      case 'marquee': {
        if (!d.moved && Math.hypot(p.x - d.start.x, p.y - d.start.y) < CLICK_SLOP) return;
        d.moved = true;
        const sr = rectFromPoints(d.start, p);
        setMarquee(sr);
        const a = screenToWorld({ x: sr.x, y: sr.y }, cam);
        const wr: Rect = { x: a.x, y: a.y, w: sr.w / cam.z, h: sr.h / cam.z };
        const hit = new Set(d.base);
        for (const it of Object.values(boardStore.getState().items)) {
          if (rectsIntersect(wr, it.kind === 'group' ? titleRect(it) : it)) hit.add(it.id);
        }
        boardStore.setSelection(hit);
        break;
      }
    }
  };

  const endDrag = (e: RPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (d.type === 'pan') setPanning(false);
    else if (d.type === 'move') {
      if (d.moved) boardStore.commit('move', d.before);
      else {
        if (d.collapseTo) boardStore.setSelection([d.collapseTo]);
        if (d.videoId) videoGate.click(d.videoId);
      }
    } else if (d.type === 'resize') boardStore.commit('resize', d.before);
    else if (d.type === 'marquee') {
      setMarquee(null);
      if (!d.moved && !d.additive) boardStore.clearSelection();
    }
  };

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (dragRef.current) return;
    if ((e.target as HTMLElement).closest('[data-nodrag]')) return; // buttons / editors inside items: no board menu
    const itemId = (e.target as HTMLElement).closest('[data-item-id]')?.getAttribute('data-item-id') ?? null;
    if (itemId && !boardStore.getState().selection.has(itemId)) boardStore.setSelection([itemId]);
    const p = toLocal(e);
    lastPtr.current = p;
    setMenu({ x: e.clientX, y: e.clientY, itemId, world: screenToWorld(p, camRef.current) });
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    let el = (e.target as HTMLElement).closest('[data-item-id]');
    if (!el) {
      // pointer capture on the board root retargets dblclick to the root: find the text/image/video under the cursor
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-item-id]');
      if (under && !under.classList.contains('group-title')) el = under;
    }
    let id = el?.getAttribute('data-item-id');
    if (!id) {
      // pointer capture on the board root can retarget the event: look under the cursor for a group title bar
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.group-title');
      const gid = under?.getAttribute('data-item-id');
      if (gid && !(document.elementFromPoint(e.clientX, e.clientY) as HTMLElement).closest('.group-dots, .group-rename')) {
        boardStore.setSelection([gid]);
        setEditingId(gid);
        return;
      }
    }
    if (id) videoGate.dblclick(id);
    const it = id ? boardStore.getState().items[id] : undefined;
    if (it?.kind === 'text') {
      boardStore.setSelection([it.id]);
      setEditingId(it.id);
      return;
    }
    if (it?.kind === 'group') {
      const tg = e.target as HTMLElement;
      if (tg.closest('.group-title') && !tg.closest('.group-dots, .group-rename')) {
        boardStore.setSelection([it.id]);
        setEditingId(it.id);
      }
      return;
    }
    if (!id || !it || (it.kind !== 'image' && it.kind !== 'video')) return;
    // Native size: server media size, else the still-local file's own element (never a thumb/poster).
    let nw = it.pxW ?? 0;
    let nh = it.pxH ?? 0;
    if (!(nw > 0 && nh > 0) && it.src) {
      const m = el!.querySelector<HTMLImageElement | HTMLVideoElement>(it.kind === 'video' ? 'video' : 'img');
      if (m instanceof HTMLVideoElement) { nw = m.videoWidth; nh = m.videoHeight; }
      else if (m instanceof HTMLImageElement) { nw = m.naturalWidth; nh = m.naturalHeight; }
    }
    if (!(nw > 0 && nh > 0)) return;
    const cur = { x: it.x, y: it.y, w: it.w, h: it.h };
    const t = toggleRealSize(cur, prevRects.get(id), nw, nh, camRef.current.z);
    if (t.action === 'restore') prevRects.delete(id);
    else prevRects.set(id, cur);
    const before = boardStore.snapshot([id]);
    boardStore.setSelection([id]);
    boardStore.transientPatch({ [id]: t.rect });
    boardStore.commit('resize', before);
  };

  // ---- drag & drop from Explorer ------------------------------------------------------------
  const fileCount = (e: RDragEvent) =>
    Math.max(1, Array.from(e.dataTransfer.items).filter((i) => i.kind === 'file').length);

  const onDragEnter = (e: RDragEvent<HTMLDivElement>) => {
    if (!hasDroppable(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
  };
  const onDragOver = (e: RDragEvent<HTMLDivElement>) => {
    if (!hasDroppable(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const p = toLocal(e);
    lastPtr.current = p;
    const at = screenToWorld(p, camRef.current);
    const count = hasFiles(e) ? fileCount(e) : 1;
    setDrop((prev) => (prev && prev.count === count && prev.at.x === at.x && prev.at.y === at.y ? prev : { count, at }));
  };
  const onDragLeave = (e: RDragEvent<HTMLDivElement>) => {
    if (!hasDroppable(e)) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDrop(null);
    }
  };
  const onDrop = (e: RDragEvent<HTMLDivElement>) => {
    if (!hasDroppable(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDrop(null);
    const p = toLocal(e);
    lastPtr.current = p;
    const at = screenToWorld(p, camRef.current);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) createItemsFromFiles(files, at); // same frame
    else {
      const urls = extractDroppedUrls(e.dataTransfer); // image / video / link from another tab: the server downloads it
      if (urls.length) createItemsFromUrls(urls, at);
    }
  };

  const onReplacePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const id = replaceTarget.current;
    replaceTarget.current = null;
    if (file && id) replaceWithFile(id, file);
  };

  useEffect(() => {
    const onReplace = (e: Event) => {
      replaceTarget.current = (e as CustomEvent<string>).detail;
      replaceInputRef.current?.click();
    };
    window.addEventListener('board:replace-file', onReplace);
    return () => window.removeEventListener('board:replace-file', onReplace);
  }, []);

  const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    createItemsFromFiles(files, pickOrigin.current ?? viewportCenterWorld());
    pickOrigin.current = null;
  };

  // ---- derived render data ---------------------------------------------------------------------
  const items = useMemo(() => Object.values(state.items), [state.items]);
  const groups = useMemo(() => groupRenderOrder(items.filter((it) => it.kind === 'group')).map((g, i) => ({ ...g, z: -1_000_000 + i })), [items]);
  const selBox = useMemo(() => {
    const sel = [...state.selection].map((id) => state.items[id]).filter(Boolean);
    return { box: boundsOf(sel), count: sel.length };
  }, [state.items, state.selection]);

  const vp: Rect = { x: -cam.x / cam.z, y: -cam.y / cam.z, w: size.w / cam.z, h: size.h / cam.z };
  const loadZone: Rect = { x: vp.x - vp.w, y: vp.y - vp.h, w: vp.w * 3, h: vp.h * 3 };

  const gridStep = 24 * cam.z;
  const gridOpacity = Math.min(1, Math.max(0, (cam.z - 0.1) / 0.25));

  const ghosts = drop
    ? gridLayout(Math.min(drop.count, MAX_GHOSTS), { x: drop.at.x - DROP_CELL / 2, y: drop.at.y - DROP_CELL / 2 }, DROP_CELL, DROP_GAP)
    : [];

  const [canReveal, setCanReveal] = useState(false);
  const [cloud, setCloud] = useState(false);
  useEffect(() => {
    void getConfig().then((c) => {
      setCloud(isCloudConfig(c));
      setCanReveal(c.canReveal && !isCloudConfig(c)); // cloud: no folder / ComfyUI on the viewer's machine
    });
  }, []);
  const revealItem = (id: string) => {
    api.reveal(id).catch((e: Error) => toast(`Can't show in folder: ${e.message}`));
  };
  const menuItem = menu?.itemId ? state.items[menu.itemId] : undefined;
  const menuEntries: MenuEntry[] = !menu
    ? []
    : menu.itemId
      ? [
          { label: 'Text', run: () => createText(menu.world) },
          { label: 'Group', run: () => createGroup(menu.world) },
          isViewable(menuItem)
            ? { label: 'Open', hint: 'Enter', run: () => openViewer(menu.itemId!) }
            : { label: 'Open', disabled: true, hint: 'not viewable' },
          menuItem?.mediaId
            ? { label: 'Download original', run: () => downloadOriginal(menu.itemId!) }
            : { label: 'Download original', disabled: true, hint: 'not uploaded' },
          ...(canReveal && menuItem?.mediaId ? [{ label: 'Show in folder', run: () => revealItem(menu.itemId!) }] : []),
          ...(menuItem?.source === 'ComfyUI' && menuItem.mediaId
            ? [cloud
              ? { label: 'Copy workflow', run: () => void copyWorkflow(menuItem.mediaId!) }
              : { label: 'Open in ComfyUI', run: () => void openInComfy(menuItem.mediaId!, menuItem.name) }]
            : []),
          { sep: true },
          { label: 'Bring to front', run: () => boardStore.reorder(boardStore.getState().selection, true) },
          { label: 'Send to back', run: () => boardStore.reorder(boardStore.getState().selection, false) },
          { label: 'Delete', hint: 'Del', danger: true, run: () => boardStore.deleteItems([...boardStore.getState().selection]) },
        ]
      : [
          { label: 'Text', run: () => createText(menu.world) },
          { label: 'Group', run: () => createGroup(menu.world) },
          { label: 'Upload here', run: () => openPicker(menu.world) },
          { label: 'Paste', hint: 'Ctrl+V', run: () => void pasteFromClipboard(menu.world) },
          { label: 'Fit all', run: fitAll },
        ];

  const rootClass = `board${spaceHeld ? ' space' : ''}${panning ? ' panning' : ''}${drop ? ' drop-active' : ''}`;
  const worldStyle: CSSProperties & { '--z': number } = {
    transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`,
    '--z': cam.z,
  };

  return (
    <div className="app">
      <div
        ref={rootRef}
        className={rootClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={onContextMenu}
        onDoubleClick={onDoubleClick}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div
          className="grid"
          style={{
            display: gridOpacity === 0 ? 'none' : 'block',
            opacity: gridOpacity,
            backgroundSize: `${gridStep}px ${gridStep}px`,
            backgroundPosition: `${cam.x - gridStep / 2}px ${cam.y - gridStep / 2}px`,
          }}
        />
        <div className="world" style={worldStyle}>
          {ghosts.map((g, i) => (
            <div key={`g${i}`} className="ghost" style={{ transform: `translate(${g.x}px, ${g.y}px)`, width: g.w, height: g.h }} />
          ))}
          {groups.map((g) => (
            <ItemView
              key={g.id}
              item={g}
              selected={state.selection.has(g.id)}
              live
              lod={0}
              editing={editingId === g.id}
              onEditDone={onEditDone}
            />
          ))}
          {items.filter((it) => it.kind !== 'group').map((it) => (
            <ItemView
              key={it.id}
              item={it}
              selected={state.selection.has(it.id)}
              live={rectsIntersect(loadZone, it)}
              lod={lodOf(Math.max(it.w, it.h) * cam.z)}
              upload={state.uploads[it.id]}
              showSource={Math.min(it.w, it.h) * cam.z >= 60}
              editing={editingId === it.id}
              onEditDone={onEditDone}
            />
          ))}
        </div>
        <div className="overlay">
          {infoOpen && (() => {
            const first = [...state.selection].map((id) => state.items[id]).find(Boolean);
            if (!first) return null;
            const W = 300;
            const right = (first.x + first.w) * cam.z + cam.x + 10;
            const left = right + W > size.w - 8 ? Math.max(8, first.x * cam.z + cam.x - W - 10) : right;
            const top = Math.min(Math.max(8, first.y * cam.z + cam.y), Math.max(8, size.h - 260));
            const pos = { left, top };
            if (first.kind === 'group') {
              const inside = groupContents(first, items);
              return <RowsPanel rows={[['Type', 'Group'], ['Title', groupProps(first.props).title], ['Items inside', String(inside.length)]]} style={pos} />;
            }
            if (first.kind === 'text') {
              const t = textProps(first.props);
              const words = t.text.trim() ? t.text.trim().split(/\s+/).length : 0;
              return <RowsPanel rows={[['Type', 'Text'], ['Characters', String(t.text.length)], ['Words', String(words)], ['Font size', `${t.size} px`]]} style={pos} />;
            }
            return <InfoPanel mediaId={first.mediaId} name={first.name} style={pos} />;
          })()}
          {(() => {
            const texts = [...state.selection].map((id) => state.items[id]).filter((it) => it?.kind === 'text');
            if (!texts.length || texts.length !== state.selection.size) return null;
            const t0 = texts[0];
            const left = Math.min(Math.max(8, t0.x * cam.z + cam.x), Math.max(8, size.w - 330));
            const top = Math.max(56, t0.y * cam.z + cam.y - 46);
            return <TextToolbar texts={texts} left={left} top={top} />;
          })()}
          {selBox.box && (
            <div
              className={`sel-box${selBox.count > 1 ? ' multi' : ''}`}
              style={{
                left: selBox.box.x * cam.z + cam.x,
                top: selBox.box.y * cam.z + cam.y,
                width: selBox.box.w * cam.z,
                height: selBox.box.h * cam.z,
              }}
            >
              {HANDLES.map((h) => (
                <div
                  key={h}
                  className="handle"
                  data-handle={h}
                  style={{ left: HANDLE_POS[h][0], top: HANDLE_POS[h][1], cursor: HANDLE_CURSOR[h] }}
                />
              ))}
            </div>
          )}
          {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
        </div>
      </div>

      <TopBar
        boardId={state.boardId}
        boardName={state.boardName}
        saveError={state.saveError}
        zoom={cam.z}
        onFit={fitAll}
        onUpload={() => openPicker(null)}
      />

      {viewerId && <Viewer items={state.items} startId={viewerId} onClose={closeViewer} />}
      <ToastHost />
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries} onClose={() => setMenu(null)} />}

      <input ref={fileInputRef} type="file" multiple hidden onChange={onPicked} />
      <input ref={replaceInputRef} type="file" hidden onChange={onReplacePicked} />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { api, type TrashItem } from './api';
import { timeAgo } from './format';
import { boardStore } from './store';
import { boardSync } from './sync';
import type { BoardInfo } from './types';
import { hasPendingTransfers } from './uploads';

interface Props {
  boardId: string;
  boardName: string;
  saveError: boolean;
  zoom: number;
  onFit: () => void;
  onUpload: () => void;
}

/** Leave the current board: flush pending saves, warn when uploads are still running, then navigate. */
async function goTo(path: string) {
  if (hasPendingTransfers() && !window.confirm('Some files are still uploading. Leave this board anyway?')) return;
  await boardSync.flush(true);
  window.location.assign(path);
}

function BoardMenu({ boardId, boardName }: { boardId: string; boardName: string }) {
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [view, setView] = useState<'menu' | 'trash'>('menu');
  const [trash, setTrash] = useState<TrashItem[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = () => api.listBoards().then(setBoards).catch((e: Error) => setError(e.message));
  // Flush first so an item deleted a moment ago is already in the trash list.
  const loadTrash = () =>
    boardSync.flush().then(() => api.trash(boardId)).then(setTrash).catch((e: Error) => setError(e.message));

  const restore = async (t: TrashItem) => {
    try {
      await api.restoreItem(t.id);
      void boardSync.poll(); // brings the item back on the canvas now, not at the next 5 s poll
      await loadTrash();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const purge = async (t: TrashItem) => {
    if (!window.confirm(`Delete "${t.name}" forever? This cannot be undone.`)) return;
    try {
      await api.purgeItem(t.id);
      await loadTrash();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    if (!open) {
      setView('menu');
      return;
    }
    setError('');
    void refresh();
    void loadTrash();
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setRenaming(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !renaming) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, renaming]);

  const create = async () => {
    try {
      const b = await api.createBoard('Untitled board');
      await goTo(`/b/${b.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const commitRename = async () => {
    const name = draft.trim();
    setRenaming(false);
    if (!name || name === boardName) return;
    try {
      const b = await api.renameBoard(boardId, name);
      boardStore.setBoardName(b.name);
      document.title = `${b.name} · Board`;
      void refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (b: BoardInfo) => {
    if (!window.confirm(`Delete the board "${b.name}" and everything on it? This cannot be undone.`)) return;
    try {
      await api.deleteBoard(b.id);
      if (b.id === boardId) {
        boardSync.stop(); // nothing left to save
        window.location.assign('/');
      } else void refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="board-menu" ref={rootRef}>
      {renaming ? (
        <input
          className="board-name-input"
          autoFocus
          value={draft}
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename();
            else if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={() => void commitRename()}
        />
      ) : (
        <button className="board-name" onClick={(e) => { e.currentTarget.blur(); setOpen((o) => !o); }}>
          {boardName} <span className="caret">▾</span>
        </button>
      )}
      {open && (
        <div className="bm-panel" onContextMenu={(e) => e.preventDefault()}>
          {view === 'trash' ? (
            <>
              <div className="tr-head">
                <button className="tr-btn" onClick={() => setView('menu')}>‹ Back</button>
                <span>Trash · items are removed for good after 30 days</span>
              </div>
              <div className="tr-list">
                {(trash ?? []).map((t) => {
                  const thumb = t.media?.urls?.thumb ?? t.media?.urls?.preview ?? null;
                  return (
                    <div key={t.id} className="tr-row">
                      {thumb && (t.kind === 'image' || t.kind === 'video' || t.media?.urls?.thumb)
                        ? <img className="tr-thumb" src={thumb} alt="" />
                        : <div className="tr-thumb">{t.kind}</div>}
                      <div className="tr-info">
                        <div className="tr-name" title={t.name}>{t.name || 'Untitled'}</div>
                        <div className="tr-when">deleted {timeAgo(t.deletedAt)}</div>
                      </div>
                      <button className="tr-btn" onClick={() => void restore(t)}>Restore</button>
                      <button className="tr-btn danger" onClick={() => void purge(t)}>Delete forever</button>
                    </div>
                  );
                })}
                {trash && !trash.length && <div className="tr-empty">Trash is empty</div>}
              </div>
              {error && <div className="bm-err">{error}</div>}
            </>
          ) : (
          <>
          <div className="bm-list">
            {boards.map((b) => (
              <div key={b.id} className={`bm-row${b.id === boardId ? ' current' : ''}`}>
                <button className="bm-name" onClick={() => (b.id === boardId ? setOpen(false) : void goTo(`/b/${b.id}`))}>
                  {b.name}
                </button>
                <button className="bm-x" title="Delete board" onClick={() => void remove(b)}>×</button>
              </div>
            ))}
          </div>
          <div className="bm-sep" />
          <button className="bm-act" onClick={() => void create()}>New board</button>
          <button
            className="bm-act"
            onClick={() => {
              setDraft(boardName);
              setRenaming(true);
              setOpen(false);
            }}
          >
            Rename this board
          </button>
          <button className="bm-act" onClick={() => { setError(''); setView('trash'); void loadTrash(); }}>
            Trash ({trash?.length ?? 0})
          </button>
          {error && <div className="bm-err">{error}</div>}
          </>
          )}
        </div>
      )}
    </div>
  );
}

export function TopBar({ boardId, boardName, saveError, zoom, onFit, onUpload }: Props) {
  return (
    <>
      <div className="topbar topbar-left">
        <BoardMenu boardId={boardId} boardName={boardName} />
        {saveError && <span className="save-warn" title="The server is not reachable. Changes are kept and will be saved when it is back.">Not saved, retrying…</span>}
      </div>
      <div className="topbar topbar-right">
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
        <button
          className="btn"
          onClick={(e) => {
            e.currentTarget.blur();
            onFit();
          }}
        >
          Fit all
        </button>
        <button
          className="btn primary"
          onClick={(e) => {
            e.currentTarget.blur();
            onUpload();
          }}
        >
          Upload
        </button>
      </div>
    </>
  );
}

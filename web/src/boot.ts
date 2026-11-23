import { api } from './api';
import { boardStore } from './store';
import { boardSync, fromServer } from './sync';
import { hasPendingTransfers } from './uploads';

const boardIdFromPath = (p: string) => /^\/b\/([^/]+)\/?$/.exec(p)?.[1] ?? null;

/** Resolve the board from the URL (`/` -> most recent board, creating one if none), load it, start autosave. */
export async function boot(): Promise<void> {
  let id = boardIdFromPath(window.location.pathname);
  if (!id) {
    const boards = await api.listBoards();
    id = boards[0]?.id ?? (await api.createBoard('Untitled board')).id;
    window.history.replaceState(null, '', `/b/${id}`);
  }
  let data;
  try {
    data = await api.getBoard(id);
  } catch (e) {
    if ((e as Error).message === 'no such board') {
      window.location.replace('/');
      await new Promise(() => {}); // navigating away
    }
    throw e;
  }
  boardStore.loadBoard(id, data.board.name, data.items.map(fromServer));
  boardSync.start(id, data.items);
  document.title = `${data.board.name} · Board`;
  window.addEventListener('beforeunload', (e) => {
    if (hasPendingTransfers()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// Undo/redo over song snapshots (JSON strings). Pure; the app pushes a snapshot after every edit
// and restores the one undo/redo returns. Consecutive edits to the same field within a short pause
// (typing, dragging a slider) merge into one step.

const MERGE_WINDOW_MS = 1500;

/** @param {{ limit?: number }} options limit: how many steps can be undone */
export function createHistory({ limit = 200 } = {}) {
  let past = [];
  let future = [];
  let present = null;
  let lastMerge = null; // { key, time } of the last push, while it may still merge

  return {
    /** Starts over from `snapshot` (e.g. another song was opened). */
    reset(snapshot) {
      present = snapshot;
      past = [];
      future = [];
      lastMerge = null;
    },
    /**
     * Records the state after an edit. Unchanged snapshots are ignored.
     * @param {string} snapshot
     * @param {{ mergeKey?: string, time?: number }} options mergeKey: the edited field
     */
    push(snapshot, { mergeKey, time = Date.now() } = {}) {
      if (snapshot === present) return;
      const merge = mergeKey && lastMerge?.key === mergeKey && time - lastMerge.time < MERGE_WINDOW_MS;
      if (!merge) {
        past.push(present);
        if (past.length > limit) past.shift();
      }
      present = snapshot;
      future = [];
      lastMerge = mergeKey ? { key: mergeKey, time } : null;
    },
    /** @returns {string|null} the snapshot to restore, or null when there is nothing to undo */
    undo() {
      if (!past.length) return null;
      future.push(present);
      present = past.pop();
      lastMerge = null;
      return present;
    },
    /** @returns {string|null} the snapshot to restore, or null when there is nothing to redo */
    redo() {
      if (!future.length) return null;
      past.push(present);
      present = future.pop();
      lastMerge = null;
      return present;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  };
}

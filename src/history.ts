/**
 * Undo and redo for the develop settings.
 *
 * `set` has the same shape as a `useState` setter, so every existing call
 * site keeps working and every change is recorded without threading an action
 * through the app.
 *
 * Changes that arrive in a burst - dragging a slider sends one per frame -
 * become a single step: a new step only begins after a pause, so one undo
 * takes back the whole drag rather than a few pixels of it.
 *
 * The stacks are kept outside React's state updater on purpose. React may
 * call an updater more than once for the same change, and moving the stacks
 * inside it made one undo pop two steps.
 */
import { useCallback, useRef, useState } from "react";

/** A new step begins when nothing has changed for this long. */
const SETTLE_MS = 450;
/** How many steps back you can go. */
const LIMIT = 100;

export interface History<T> {
  value: T;
  set: (next: T | ((prev: T) => T)) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Start again from this value, forgetting the past (a new photo). */
  reset: (value: T) => void;
}

export function useHistory<T>(initial: T): History<T> {
  const [value, setValue] = useState<T>(initial);
  // the live value, so a change can be resolved without React's updater
  const latest = useRef<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const lastChange = useRef(0);
  // the stacks live in refs so a drag does not re-render on every frame; this
  // is bumped only when the buttons need to change
  const [, bump] = useState(0);
  const refresh = useCallback(() => bump((n) => n + 1), []);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const prev = latest.current;
      const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (Object.is(resolved, prev)) return;
      const now = Date.now();
      if (now - lastChange.current > SETTLE_MS) {
        past.current.push(prev);
        if (past.current.length > LIMIT) past.current.shift();
        const hadFuture = future.current.length > 0;
        future.current = [];
        if (past.current.length === 1 || hadFuture) refresh();
      }
      lastChange.current = now;
      latest.current = resolved;
      setValue(resolved);
    },
    [refresh],
  );

  const undo = useCallback(() => {
    const step = past.current.pop();
    if (step === undefined) return;
    future.current.push(latest.current);
    latest.current = step;
    // the restored step is its own resting point, so the next edit starts a
    // fresh step rather than folding into this one
    lastChange.current = 0;
    setValue(step);
    refresh();
  }, [refresh]);

  const redo = useCallback(() => {
    const step = future.current.pop();
    if (step === undefined) return;
    past.current.push(latest.current);
    latest.current = step;
    lastChange.current = 0;
    setValue(step);
    refresh();
  }, [refresh]);

  const reset = useCallback(
    (v: T) => {
      past.current = [];
      future.current = [];
      lastChange.current = 0;
      latest.current = v;
      setValue(v);
      refresh();
    },
    [refresh],
  );

  return {
    value,
    set,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    reset,
  };
}

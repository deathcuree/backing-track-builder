import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../shared/history.js';

test('undo and redo step through the snapshots', () => {
  const h = createHistory();
  h.reset('a');
  assert.equal(h.canUndo(), false);
  h.push('b');
  h.push('c');
  assert.equal(h.undo(), 'b');
  assert.equal(h.undo(), 'a');
  assert.equal(h.undo(), null);
  assert.equal(h.canRedo(), true);
  assert.equal(h.redo(), 'b');
  assert.equal(h.redo(), 'c');
  assert.equal(h.redo(), null);
});

test('an unchanged snapshot is not a step', () => {
  const h = createHistory();
  h.reset('a');
  h.push('a');
  assert.equal(h.canUndo(), false);
});

test('a new edit after undo clears redo', () => {
  const h = createHistory();
  h.reset('a');
  h.push('b');
  h.undo();
  h.push('c');
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo(), 'a');
});

test('a burst of edits to one field is one step', () => {
  const h = createHistory();
  h.reset('t');
  h.push('ti', { mergeKey: 'title', time: 1000 });
  h.push('tit', { mergeKey: 'title', time: 1300 });
  h.push('titl', { mergeKey: 'title', time: 1600 });
  assert.equal(h.undo(), 't');
  assert.equal(h.canUndo(), false);
});

test('a pause, another field or an undo starts a new step', () => {
  const h = createHistory();
  h.reset('0');
  h.push('1', { mergeKey: 'bpm', time: 0 });
  h.push('2', { mergeKey: 'bpm', time: 5000 }); // pause
  h.push('3', { mergeKey: 'title', time: 5100 }); // other field
  assert.equal(h.undo(), '2');
  assert.equal(h.undo(), '1');
  h.redo();
  h.push('4', { mergeKey: 'bpm', time: 5200 }); // after an undo/redo, never merged
  assert.equal(h.undo(), '2');
});

test('keeps the last 200 steps', () => {
  const h = createHistory();
  h.reset('s0');
  for (let i = 1; i <= 250; i++) h.push(`s${i}`);
  let steps = 0;
  let last = null;
  while (h.canUndo()) {
    last = h.undo();
    steps++;
  }
  assert.equal(steps, 200);
  assert.equal(last, 's50');
});

test('reset forgets everything', () => {
  const h = createHistory();
  h.reset('a');
  h.push('b');
  h.reset('x');
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
});

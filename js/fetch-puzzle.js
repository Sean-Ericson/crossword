/*
 * fetch-puzzle.js — puzzle loading and on-demand retrieval.
 *
 * A browser can't download from NYT itself (no CORS headers, and the
 * session cookies are same-site), so the server does it: POST
 * /api/puzzles/<id>/fetch runs tools/fetch_one.py and answers once the
 * .puz is in the archive.
 */

import { ARCHIVE_START } from './config.js';
import { parsePuzzleId } from './util.js';
import { api } from './api.js';

/** Is this id something NYT plausibly published? */
export function isFetchable(puzzleId) {
  const { type, date } = parsePuzzleId(puzzleId);
  const start = ARCHIVE_START[type];
  if (!start || !date) return false;
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate()
  ).padStart(2, '0')}`;
  return date >= start && date <= todayStr;
}

export function puzzleUrl(puzzleId) {
  return `./puzzles/${encodeURIComponent(puzzleId)}.puz`;
}

/** @returns {Promise<ArrayBuffer|null>} the .puz bytes, or null if absent */
export async function tryLoadPuzzle(puzzleId, { bustCache = false } = {}) {
  try {
    const url = puzzleUrl(puzzleId) + (bustCache ? `?t=${Date.now()}` : '');
    const resp = await fetch(url, bustCache ? { cache: 'no-store' } : {});
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    // A stray HTML 404 page would parse as garbage; .puz files are small
    // but never this small.
    return buf.byteLength > 100 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Ask the server to download a puzzle, then load it.
 * @returns {Promise<{ok: true, buffer: ArrayBuffer, id: string} |
 *                   {ok: false, reason: 'missing'|'error', message?: string}>}
 */
export async function fetchOnDemand(puzzleId) {
  let result;
  try {
    result = await api.post(`puzzles/${encodeURIComponent(puzzleId)}/fetch`);
  } catch (err) {
    return { ok: false, reason: 'error', message: err.message };
  }
  if (result.status === 'missing') {
    return { ok: false, reason: 'missing', message: result.message || 'NYT has no puzzle for that date.' };
  }
  if (result.status !== 'done') {
    return { ok: false, reason: 'error', message: result.message || 'The download failed.' };
  }
  const id = result.id || puzzleId;
  const buffer = await tryLoadPuzzle(id, { bustCache: true });
  return buffer ? { ok: true, buffer, id } : { ok: false, reason: 'error', message: 'Downloaded, but the file is missing.' };
}

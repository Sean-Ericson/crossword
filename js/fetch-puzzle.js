/*
 * fetch-puzzle.js — on-demand puzzle retrieval.
 *
 * A browser can't download from NYT itself (no CORS headers, and the
 * session cookies are same-site), so this queues a request in the data
 * repo and waits for the machine running tools/fetch_requests.py to
 * commit the .puz to the site repo.
 *
 * Flow: PUT requests/<id>.json -> poll it until the fetcher marks it
 * done/missing -> poll the site for the .puz itself (Pages needs a moment
 * to publish) -> hand back the bytes.
 */

import { ARCHIVE_START, FETCH_POLL_MS, FETCH_TIMEOUT_MS } from './config.js';
import { parsePuzzleId } from './util.js';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Queue a fetch and wait for it to land.
 * @param {string} puzzleId
 * @param {import('./sync.js').Sync} sync   must be active
 * @param {(stage: string, detail?: object) => void} onProgress
 * @returns {Promise<{ok: true, buffer: ArrayBuffer} |
 *                   {ok: false, reason: 'missing'|'error'|'timeout'|'offline',
 *                    message?: string}>}
 */
export async function fetchOnDemand(puzzleId, sync, onProgress = () => {}) {
  if (!sync?.active) return { ok: false, reason: 'offline' };

  const { type, date } = parsePuzzleId(puzzleId);
  onProgress('requesting');
  const queued = await sync.requestPuzzle(puzzleId, { type, date });
  if (!queued) return { ok: false, reason: 'error', message: 'Could not reach the data repo.' };

  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let status = queued.status;
  let message = queued.message;

  // 1) wait for the fetcher to act on the request
  while (status === 'pending' && Date.now() < deadline) {
    onProgress('waiting', { since: queued.requested_at });
    await sleep(FETCH_POLL_MS);
    const current = await sync.getRequest(puzzleId);
    if (current) {
      status = current.status;
      message = current.message;
    }
  }
  if (status === 'missing') {
    return { ok: false, reason: 'missing', message: message || 'NYT has no puzzle for that date.' };
  }
  if (status === 'error') {
    return { ok: false, reason: 'error', message: message || 'The download failed.' };
  }
  if (status !== 'done') return { ok: false, reason: 'timeout' };

  // 2) the file is committed; wait for GitHub Pages to publish it
  onProgress('publishing');
  while (Date.now() < deadline) {
    const buffer = await tryLoadPuzzle(puzzleId, { bustCache: true });
    if (buffer) return { ok: true, buffer };
    await sleep(FETCH_POLL_MS);
  }
  return { ok: false, reason: 'timeout' };
}

/*
 * puz-write.js — write an Across Lite .puz (version 1.3) for a puzzle in
 * the parsePuz shape (js/puz.js; docToPuz for custom puzzles), the reverse
 * of puz.js. Text is Windows-1252 (characters it can't hold become '?'),
 * and every checksum is filled in, so strict readers (Across Lite, puzpy)
 * open it. Circles go in a GEXT section and rebus squares in GRBS/RTBL,
 * the way NYT's files carry them. A square without an answer yet (a
 * draft) is written as '-'.
 *
 * Checksums, as tools/puz.py computes them: every one is the 16-bit
 * rotate-and-add `checksum` below. The header's covers width through
 * solution state; the file's continues over the solution, the fill and the
 * text (title, author, copyright and notes with their NULs, clues
 * without); the eight "masked" bytes XOR the low and high bytes of the
 * header, solution, fill and text sums with "ICHEATED".
 */

import { encodeCp1252 } from './cp1252.js';

const MASK = 'ICHEATED';

/** The 16-bit rotate-and-add checksum .puz files use. */
export function checksum(bytes, sum = 0) {
  for (const b of bytes) {
    sum = (sum >>> 1) | ((sum & 1) << 15);
    sum = (sum + b) & 0xffff;
  }
  return sum;
}

const zero = (bytes) => [...bytes, 0];

/** @returns {Uint8Array} the .puz file */
export function writePuz(puz) {
  const { width, height } = puz;
  const n = width * height;
  const enc = (text) => encodeCp1252(text ?? '');
  const solution = Uint8Array.from({ length: n }, (_, i) => {
    const ch = puz.solution[i];
    if (ch === '.' || ch === ':') return 0x2e;
    return /^[A-Za-z0-9]$/.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0x2d; // '-': no answer yet
  });
  const fill = Uint8Array.from({ length: n }, (_, i) => (solution[i] === 0x2e ? 0x2e : 0x2d));
  const title = enc(puz.title);
  const author = enc(puz.author);
  const copyright = enc(puz.copyright);
  const notes = enc(puz.notes);
  const clues = puz.clues.map(enc);

  // width, height, clue count, type 1 (normal), solution state 0 (not scrambled)
  const header = [width, height, clues.length & 0xff, clues.length >> 8, 1, 0, 0, 0];
  const headerSum = checksum(header);
  const textSum = (sum) => {
    if (title.length) sum = checksum(zero(title), sum);
    if (author.length) sum = checksum(zero(author), sum);
    if (copyright.length) sum = checksum(zero(copyright), sum);
    for (const clue of clues) if (clue.length) sum = checksum(clue, sum);
    if (notes.length) sum = checksum(zero(notes), sum);
    return sum;
  };
  const fileSum = textSum(checksum(fill, checksum(solution, headerSum)));
  const masked = new Uint8Array(8);
  [headerSum, checksum(solution), checksum(fill), textSum(0)].forEach((sum, k) => {
    masked[k] = MASK.charCodeAt(k) ^ (sum & 0xff);
    masked[k + 4] = MASK.charCodeAt(k + 4) ^ (sum >> 8);
  });

  const extensions = [];
  const rebus = Object.entries(puz.rebusSquares ?? {});
  if (rebus.length) {
    const keys = [...new Set(rebus.map(([, answer]) => answer))];
    const table = new Uint8Array(n);
    for (const [i, answer] of rebus) table[Number(i)] = keys.indexOf(answer) + 1;
    extensions.push(['GRBS', table]);
    extensions.push(['RTBL', enc(keys.map((answer, k) => `${String(k).padStart(2)}:${answer};`).join(''))]);
  }
  if (puz.circled?.length) {
    const markup = new Uint8Array(n);
    for (const i of puz.circled) markup[i] = 0x80;
    extensions.push(['GEXT', markup]);
  }

  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const ascii = (s) => out.push(...[...s].map((c) => c.charCodeAt(0)));
  u16(fileSum);
  ascii('ACROSS&DOWN\0');
  u16(headerSum);
  out.push(...masked);
  ascii('1.3\0');
  out.push(0, 0); // reserved
  u16(0); // scrambled checksum
  out.push(...new Array(12).fill(0)); // reserved
  out.push(...header);
  out.push(...solution, ...fill);
  for (const text of [title, author, copyright, ...clues, notes]) out.push(...zero(text));
  for (const [code, data] of extensions) {
    ascii(code);
    u16(data.length);
    u16(checksum(data));
    out.push(...data, 0);
  }
  return Uint8Array.from(out);
}

/** A file name for a puzzle: "word-square.puz". */
export function puzFileName(title, fallback = 'puzzle') {
  const slug = String(title ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 -]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return `${slug || fallback}.puz`;
}

/** Save a .puz in the browser. */
export function downloadPuz(puz, name) {
  const url = URL.createObjectURL(new Blob([writePuz(puz)], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

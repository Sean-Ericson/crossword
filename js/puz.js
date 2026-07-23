/*
 * puz.js — minimal Across Lite (.puz) binary parser.
 *
 * Modeled on puzpy (https://github.com/alexdej/puzpy, MIT) via the
 * copy vendored at tools/puz.py. Read-only: enough to play a puzzle.
 * Checksums are deliberately NOT enforced.
 *
 * Layout (offsets relative to the byte 2 before the "ACROSS&DOWN" magic,
 * which tolerates preamble junk at the start of the file):
 *   u16  @0   global checksum        (ignored)
 *   11s  @2   "ACROSS&DOWN" + NUL
 *   u16  @14  header checksum        (ignored)
 *   8b   @16  masked checksums       (ignored)
 *   4s   @24  version, e.g. "1.3\0"
 *   2b   @28  unused
 *   u16  @30  scrambled checksum
 *   12b  @32  unused
 *   u8   @44  width
 *   u8   @45  height
 *   u16  @46  clue count
 *   u16  @48  puzzle type   (0x0001 normal, 0x0401 diagramless)
 *   u16  @50  solution state (0 = unlocked, 4 = scrambled)
 *   @52: solution (w*h bytes, '.' = black, ':' = black in diagramless),
 *        fill (w*h bytes), then NUL-terminated strings:
 *        title, author, copyright, clues x N, notes.
 *   Then extensions: [4s code][u16 len][u16 cksum][data][NUL] repeated.
 *     GRBS: byte per cell; v>0 means rebus key v-1 in RTBL
 *     RTBL: " 0:HEART; 1:DIAMOND;" key:value dict string
 *     GEXT: byte per cell; bit 0x80 = circled
 */

const MAGIC = 'ACROSS&DOWN';

export class PuzParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PuzParseError';
  }
}

export function isBlackChar(ch) {
  return ch === '.' || ch === ':';
}

function findMagic(bytes) {
  outer: for (let i = 0; i + MAGIC.length <= bytes.length; i++) {
    for (let j = 0; j < MAGIC.length; j++) {
      if (bytes[i + j] !== MAGIC.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

// "k1:v1;k2:v2;" with possibly space-padded integer keys -> {int: string}
function parseDictString(s) {
  const out = {};
  for (const part of s.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const key = parseInt(part.slice(0, colon).trim(), 10);
    if (!Number.isNaN(key)) out[key] = part.slice(colon + 1);
  }
  return out;
}

/**
 * Parse a .puz file.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{
 *   width: number, height: number, version: string,
 *   scrambled: boolean, diagramless: boolean,
 *   title: string, author: string, copyright: string, notes: string,
 *   solution: string, fill: string, clues: string[],
 *   circled: number[],                       // cell indexes with GEXT 0x80
 *   rebus: {table: number[], solutions: Object<number,string>} | null,
 *   rebusSquares: Object<number,string>,     // cell index -> full solution
 * }}
 */
export function parsePuz(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magicAt = findMagic(bytes);
  if (magicAt < 2) {
    throw new PuzParseError('not a .puz file (ACROSS&DOWN magic not found)');
  }
  const start = magicAt - 2;
  if (start + 52 > bytes.length) {
    throw new PuzParseError('truncated .puz header');
  }

  // --- header ---
  let version = '';
  for (let i = 0; i < 4; i++) {
    const b = bytes[start + 24 + i];
    if (b === 0) break;
    version += String.fromCharCode(b);
  }
  const major = parseInt(version, 10) || 1;
  // v1.x is nominally ISO-8859-1 but windows-1252 is a superset in practice
  // (NYT smart punctuation lands in 0x80-0x9F); v2.x is UTF-8.
  const decoder = new TextDecoder(major < 2 ? 'windows-1252' : 'utf-8');

  const width = bytes[start + 44];
  const height = bytes[start + 45];
  const numClues = dv.getUint16(start + 46, true);
  const puzzleType = dv.getUint16(start + 48, true);
  const solutionState = dv.getUint16(start + 50, true);
  const nCells = width * height;
  if (!nCells) throw new PuzParseError('zero-sized grid');

  let pos = start + 52;
  if (pos + 2 * nCells > bytes.length) {
    throw new PuzParseError('truncated .puz grid');
  }

  const readBlock = (n) => {
    const out = bytes.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const readString = () => {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0) end++;
    const s = decoder.decode(bytes.subarray(pos, end));
    pos = Math.min(end + 1, bytes.length);
    return s;
  };

  const solution = decoder.decode(readBlock(nCells));
  const fill = decoder.decode(readBlock(nCells));

  const title = readString();
  const author = readString();
  const copyright = readString();
  const clues = [];
  for (let i = 0; i < numClues; i++) clues.push(readString());
  const notes = readString();

  // --- extensions ---
  const extensions = {};
  while (pos + 8 <= bytes.length) {
    let code = '';
    for (let i = 0; i < 4; i++) code += String.fromCharCode(bytes[pos + i]);
    const len = dv.getUint16(pos + 4, true);
    pos += 8;
    extensions[code] = bytes.subarray(pos, Math.min(pos + len, bytes.length));
    pos += len + 1; // data + trailing NUL
  }

  const circled = [];
  if (extensions.GEXT) {
    extensions.GEXT.forEach((b, i) => {
      if (b & 0x80) circled.push(i);
    });
  }

  let rebus = null;
  const rebusSquares = {};
  if (extensions.GRBS) {
    const table = Array.from(extensions.GRBS);
    const solutions = extensions.RTBL
      ? parseDictString(decoder.decode(extensions.RTBL))
      : {};
    rebus = { table, solutions };
    table.forEach((v, i) => {
      if (v > 0 && solutions[v - 1] !== undefined) {
        rebusSquares[i] = solutions[v - 1];
      }
    });
  }

  return {
    width,
    height,
    version,
    scrambled: solutionState !== 0,
    diagramless: puzzleType === 0x0401,
    title,
    author,
    copyright,
    notes,
    solution,
    fill,
    clues,
    circled,
    rebus,
    rebusSquares,
  };
}

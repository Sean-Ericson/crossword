/*
 * cp1252.js — Windows-1252, the text encoding of version 1.x .puz files.
 *
 * Done by hand rather than with TextDecoder('windows-1252'): some Node 22
 * releases decode that label as plain Latin-1, which turns NYT's curly
 * quotes (0x91-0x94) into invisible control characters. Bytes below 0x80
 * and from 0xA0 up are the same in both; only 0x80-0x9F differ.
 */

// 0x80..0x9F. The five bytes Windows-1252 leaves undefined map to the C1
// control with the same number, as the WHATWG decoder does.
const HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

const ENCODE = new Map(HIGH.map((code, k) => [code, 0x80 + k]));

/** @param {Uint8Array} bytes */
export function decodeCp1252(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    const chunk = Array.from(bytes.subarray(i, i + 0x2000), (b) => (b >= 0x80 && b < 0xa0 ? HIGH[b - 0x80] : b));
    out += String.fromCharCode(...chunk);
  }
  return out;
}

/**
 * @param {string} text
 * @param {string} [fallback] byte used for characters Windows-1252 can't hold
 * @returns {Uint8Array}
 */
export function encodeCp1252(text, fallback = '?') {
  const bytes = [];
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else if (ENCODE.has(code)) bytes.push(ENCODE.get(code));
    else bytes.push(fallback.charCodeAt(0));
  }
  return Uint8Array.from(bytes);
}

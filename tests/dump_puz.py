#!/usr/bin/env python3
"""Dump a .puz file's parsed contents as JSON, for cross-checking js/puz.js
and js/model.js against the vendored reference parser (tools/puz.py, puzpy).

Usage: python tests/dump_puz.py file.puz [out.json]
"""
import json
import os
import sys

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'tools')
)
import puz  # noqa: E402

puz.IGNORE_CHECKSUMS = True
# Browsers' TextDecoder('latin1'/'windows-1252') is windows-1252; use the
# same superset of ISO-8859-1 here so both dumps agree on bytes 0x80-0x9F.
puz.ENCODING = 'cp1252'


def words(entries):
    return [
        {
            'num': e['num'],
            'clueIndex': e['clue_index'],
            'cell': e['cell'],
            'len': e['len'],
        }
        for e in entries
    ]


def dump(path):
    p = puz.read(path)
    cn = p.clue_numbering()

    markup = p.markup().markup if p.has_markup() else []
    circled = [i for i, b in enumerate(markup) if b & puz.GridMarkup.Circled]

    rebus_squares = {}
    if p.has_rebus():
        r = p.rebus()
        for i in r.get_rebus_squares():
            rebus_squares[str(i)] = r.get_rebus_solution(i)

    return {
        'width': p.width,
        'height': p.height,
        'version': p.version.decode(),
        'scrambled': p.is_solution_locked(),
        'title': p.title,
        'author': p.author,
        'copyright': p.copyright,
        'notes': p.notes,
        'solution': p.solution,
        'fill': p.fill,
        'clues': p.clues,
        'across': words(cn.across),
        'down': words(cn.down),
        'circled': circled,
        'rebusSquares': rebus_squares,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    out = dump(sys.argv[1])
    text = json.dumps(out, ensure_ascii=False, indent=1)
    if len(sys.argv) > 2:
        with open(sys.argv[2], 'w', encoding='utf-8', newline='\n') as f:
            f.write(text + '\n')
        print(f'wrote {sys.argv[2]}')
    else:
        print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())

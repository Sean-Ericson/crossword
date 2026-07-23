#!/usr/bin/env python3
"""Generate tests/fixtures/fixture15.puz — a synthetic 15x15 puzzle with a
rebus, circled squares, an across-length-1 cell (down-only), and
windows-1252 punctuation, used by run_tests.mjs.

Usage: python tests/make_fixture.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
import puz  # noqa: E402

W = H = 15

# '.' = black. r7c7 is white with black on both sides -> down-only cell.
PATTERN = [
    'AAAA.AAAAA.AAAA',
    'AAAA.AAAAA.AAAA',
    'AAAAAAAAAAAAAAA',
    '...AAA..AAAA...',
    'AAAAA.AAAA.AAAA',
    'AAAA.AAAA.AAAAA',
    'AAA.AAAA.AAAAAA',
    'AAAAAA.A.AAAAAA',
    'AAAAAA.AAAA.AAA',
    'AAAAA.AAAA.AAAA',
    'AAAA.AAAA.AAAAA',
    '...AAAA.AAA....',
    'AAAAAAAAAAAAAAA',
    'AAAA.AAAAA.AAAA',
    'AAAA.AAAAA.AAAA',
]

REBUS = {(2, 0): 'HEART', (12, 14): 'QUARTZ'}  # cell -> full answer
CIRCLED = [32, 33, 34, 100, 101]


def main():
    grid = []
    for r, row in enumerate(PATTERN):
        assert len(row) == W, f'row {r} has length {len(row)}'
        for c, ch in enumerate(row):
            i = r * W + c
            if ch == '.':
                grid.append('.')
            elif (r, c) in REBUS:
                grid.append(REBUS[(r, c)][0])
            else:
                grid.append(chr(ord('A') + (i * 7 + 3) % 26))
    solution = ''.join(grid)

    # sanity: every white cell must belong to at least one word (len > 1)
    numbering = puz.DefaultClueNumbering(solution, [''] * 200, W, H)
    covered = set()
    for e in numbering.across:
        covered.update(range(e['cell'], e['cell'] + e['len']))
    for e in numbering.down:
        covered.update(e['cell'] + k * W for k in range(e['len']))
    for i, ch in enumerate(solution):
        if ch != '.':
            assert i in covered, f'cell {i} is in no word - fix PATTERN'

    # clue list in .puz order: scan order, across before down per cell
    entries = sorted(
        [(e['clue_index'], e['num'], 'Across', e) for e in numbering.across]
        + [(e['clue_index'], e['num'], 'Down', e) for e in numbering.down]
    )
    clues = []
    for clue_index, num, direction, e in entries:
        if clue_index == 0:
            clues.append('“Fancy” clue… with a dash — right?')
        elif clue_index == 1:
            clues.append("It’s the 2nd clue & more")
        else:
            clues.append(f'Clue {num} {direction} (len {e["len"]})')

    p = puz.Puzzle()
    p.encoding = 'cp1252'
    p.width = W
    p.height = H
    p.solution = solution
    p.fill = ''.join('.' if ch == '.' else '-' for ch in solution)
    p.clues = clues
    p.title = 'Test Fixture ’ 15×15'
    p.author = 'make_fixture.py / Crossword Site'
    p.copyright = '© 2026 Test'
    p.notes = 'Synthetic fixture with rebus + circles.'

    rebus = p.create_empty_rebus()
    for i in range(W * H):
        r, c = divmod(i, W)
        rebus.add_rebus(REBUS.get((r, c)))

    markup = p.markup()
    markup.markup = [0x80 if i in CIRCLED else 0 for i in range(W * H)]

    out = os.path.join(HERE, 'fixtures', 'fixture15.puz')
    p.save(out)
    print(
        f'wrote {out}: {len(numbering.across)} across, '
        f'{len(numbering.down)} down, {len(clues)} clues'
    )


if __name__ == '__main__':
    main()

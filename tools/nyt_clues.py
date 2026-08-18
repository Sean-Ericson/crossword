#!/usr/bin/env python3
"""nyt_clues.py - preserve NYT's clue formatting in the .puz file.

NYT sends each clue twice: `plain` ("Just this once") and `formatted`
("<i>Just this once</i>"). nytxw_puz keeps only `plain`, because the .puz
format has no notion of markup - clue text is a flat Latin-1 string.

Rather than corrupt the clue text with literal tags, the formatting is
stored in a custom extension section, `FCLU`. The .puz spec gives
extensions a 4-byte code, a length and a checksum, and readers skip codes
they don't recognise - so Across Lite and friends still open these files
and simply show the unformatted clues, while js/puz.js picks the markup up.

Payload: UTF-8 JSON mapping clue index (position in the puzzle's clue
list) to its HTML, holding only the clues whose formatting differs from
the plain text. Most puzzles have none, so the section is usually absent.
"""
import json

FCLU = b'FCLU'


def formatted_clues(data):
    """
    Formatted HTML per clue, in the same order nytxw_puz writes them.

    Mirrors the ordering loop in nyt.py's data_to_puz (clues are emitted in
    grid-scan order, not NYT's own order), so indexes line up with p.clues.
    Entries are None where NYT gave no distinct formatting.
    """
    seen = set()
    out = []
    for cell in data.get('cells', []):
        for clue_index in cell.get('clues', []):
            if clue_index in seen:
                continue
            seen.add(clue_index)
            text = data['clues'][clue_index]['text']
            if isinstance(text, list):
                text = text[0] if text else {}
            if isinstance(text, dict):
                plain = text.get('plain', '')
                rich = text.get('formatted')
                out.append(rich if rich and rich != plain else None)
            else:
                out.append(None)
    return out


def attach_formatted_clues(puzzle, data):
    """
    Add the FCLU section to `puzzle` if any clue carries formatting.
    Returns how many formatted clues were stored.
    """
    rich = formatted_clues(data)
    mapping = {str(i): html for i, html in enumerate(rich) if html}
    if not mapping:
        return 0
    payload = json.dumps(mapping, ensure_ascii=False, separators=(',', ':'))
    puzzle.extensions[FCLU] = payload.encode('utf-8')
    return len(mapping)

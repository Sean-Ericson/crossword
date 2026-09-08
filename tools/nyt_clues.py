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
import os
import re
import urllib.request

FCLU = b'FCLU'

# Some clues are pictures rather than words (rebus-style Sunday themes).
# NYT delivers them as <img src="https://www.nytimes.com/games-assets/...">,
# which we can't leave pointing at their servers: the site would hotlink
# assets that may vanish, and the player refuses remote image sources.
IMG_SRC_RE = re.compile(r'(<img[^>]*?src=")([^"]+)(")', re.IGNORECASE)
SAFE_NAME_RE = re.compile(r'[^A-Za-z0-9._-]+')
IMAGE_TIMEOUT = 30

# NYT's `formatted` also HTML-escapes quotes and apostrophes, so it differs
# from `plain` on plenty of clues that carry no styling at all. Only an
# actual tag is worth storing.
HAS_TAG_RE = re.compile(r'<[a-zA-Z/][^>]*>')


def has_markup(html):
    return bool(html) and bool(HAS_TAG_RE.search(html))


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
                rich = text.get('formatted')
                out.append(rich if has_markup(rich) else None)
            else:
                out.append(None)
    return out


def is_remote(src):
    return bool(re.match(r'(?i)^(?:[a-z][a-z0-9+.-]*:)?//', src or ''))


def localize_images(mapping, puzzle_id, images_dir):
    """
    Download any remote clue images into images_dir/<puzzle_id>/ and point
    the markup at the local copies instead. Returns how many were saved.

    A download that fails leaves that clue's markup untouched, so it simply
    falls back to the plain text rather than losing the whole section.
    """
    if not puzzle_id or not images_dir:
        return 0
    saved = 0
    for key, html in list(mapping.items()):
        def replace(match, key=key):
            nonlocal saved
            prefix, src, suffix = match.group(1), match.group(2), match.group(3)
            if not is_remote(src):
                return match.group(0)  # already local
            name = SAFE_NAME_RE.sub('_', os.path.basename(src.split('?')[0]))
            if not name:
                return match.group(0)
            target_dir = os.path.join(images_dir, puzzle_id)
            target = os.path.join(target_dir, name)
            if not os.path.isfile(target):
                try:
                    request = urllib.request.Request(
                        src, headers={'User-Agent': 'crossword-site'}
                    )
                    with urllib.request.urlopen(request, timeout=IMAGE_TIMEOUT) as r:
                        blob = r.read()
                    os.makedirs(target_dir, exist_ok=True)
                    with open(target, 'wb') as f:
                        f.write(blob)
                except Exception as exc:  # noqa: BLE001 - keep the clue usable
                    print(f'    image {src} failed: {exc}'[:150])
                    return match.group(0)
            saved += 1
            return f'{prefix}./puzzles/images/{puzzle_id}/{name}{suffix}'

        mapping[key] = IMG_SRC_RE.sub(replace, html)
    return saved


def attach_formatted_clues(puzzle, data, puzzle_id=None, images_dir=None):
    """
    Add the FCLU section to `puzzle` if any clue carries formatting, saving
    any picture clues alongside the archive. Returns how many formatted
    clues were stored.
    """
    rich = formatted_clues(data)
    mapping = {str(i): html for i, html in enumerate(rich) if html}
    if not mapping:
        return 0
    localize_images(mapping, puzzle_id, images_dir)
    payload = json.dumps(mapping, ensure_ascii=False, separators=(',', ':'))
    puzzle.extensions[FCLU] = payload.encode('utf-8')
    return len(mapping)

/*
 * people.js — showing people: the account color palette, telling people
 * apart when several share a view, short name lists, and picker order.
 * No DOM; shared by the browser and the server.
 */

// Okabe-Ito-ish palette: distinct under common color-vision deficiencies,
// dark enough to read as a cursor border on white. New accounts get the
// least-used color. With more accounts than colors, colors repeat, and
// distinctColors() separates whoever ends up in the same view.
export const USER_PALETTE = [
  '#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#7B61FF', '#8C564B',
];

/**
 * One color per person for a view that shows several people at once (a
 * co-op solve, a stats comparison). Everyone keeps their own color unless
 * someone earlier in the list has the same one. Those people get the first
 * palette color that nobody in the view has. Past the palette's size,
 * colors repeat, so those views show names too.
 *
 * Pass the view's current colors as `keep` when people are added or
 * removed. Anyone already shown then keeps the color they have, so nobody
 * changes color while people are looking at it.
 * @param {Array<{name:string, color:string}>} people
 * @param {{keep?: Map<string, string>, palette?: string[]}} [opts]
 * @returns {Map<string, string>} name -> color
 */
export function distinctColors(people, { keep = new Map(), palette = USER_PALETTE } = {}) {
  const colors = new Map();
  const taken = new Set();
  const give = (name, color) => {
    colors.set(name, color);
    taken.add(color);
  };
  for (const { name } of people) {
    if (keep.has(name) && !colors.has(name)) give(name, keep.get(name));
  }
  // own colors first, so a stand-in color never takes someone else's
  for (const { name, color } of people) {
    if (!colors.has(name) && !taken.has(color)) give(name, color);
  }
  for (const { name, color } of people) {
    if (!colors.has(name)) give(name, palette.find((c) => !taken.has(c)) ?? color);
  }
  return colors;
}

/**
 * "Devon", "Devon and Kam", "Devon, Kam and Tom". More than `max` names
 * fold the tail into a count: listNames(five, 3) is "Devon, Kam and 3
 * others". A lone name is never folded ("and 1 other" is no shorter).
 */
export function listNames(names, max = Infinity) {
  let items = [...names];
  const keep = Math.max(1, max - 1);
  if (items.length > max && items.length - keep >= 2) {
    items = [...items.slice(0, keep), `${items.length - keep} others`];
  }
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Sort comparator: by display name, ignoring case, then by account name. */
export function byDisplayName(a, b) {
  return (
    (a.display_name || a.name).localeCompare(b.display_name || b.name, 'en', { sensitivity: 'base' }) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Order people for a picker: the ones you shared a co-op solve with most
 * recently first (up to `max`, newest first), then everyone else A-Z.
 * @param {Array<{name, display_name, last_together?: string|null}>} users
 */
export function pickerGroups(users, max = 5) {
  const recent = users
    .filter((u) => u.last_together)
    .sort((a, b) => b.last_together.localeCompare(a.last_together) || byDisplayName(a, b))
    .slice(0, max);
  const top = new Set(recent.map((u) => u.name));
  return { recent, rest: users.filter((u) => !top.has(u.name)).sort(byDisplayName) };
}

'use strict';
// Pinned tabs and tab groups: the rules for the tab order, used by Browser. Pinned tabs come first;
// the tabs of a group stay next to each other, where the group's first tab is (as in Chrome).

// Group colours (Chrome's set), in the order new groups take them; the strip and the menus use these.
const COLOR_HEX = {
  blue: '#4c8bf5', red: '#e5534b', yellow: '#d29922', green: '#3fb950', pink: '#e86fb0',
  purple: '#a371f7', cyan: '#39c5cf', orange: '#f0883e', grey: '#8a8f98',
};
const COLORS = Object.keys(COLOR_HEX);

/** `order` (tab ids) rearranged: pinned tabs first, then the rest with each group's tabs together. */
function normalizeOrder(order, tabOf) {
  const pinned = order.filter((id) => tabOf(id) && tabOf(id).pinned);
  const rest = [];
  const placed = new Set();
  for (const id of order) {
    const t = tabOf(id);
    if (!t || t.pinned || placed.has(id)) continue;
    const members = t.groupId == null ? [id] : order.filter((j) => tabOf(j) && !tabOf(j).pinned && tabOf(j).groupId === t.groupId);
    for (const j of members) { rest.push(j); placed.add(j); }
  }
  return [...pinned, ...rest];
}

/** The colour for a new group: the first one no group in the window uses yet. */
function nextColor(used) {
  return COLORS.find((c) => !used.includes(c)) || COLORS[used.length % COLORS.length];
}

/** A group from a saved session or the UI, cleaned: { title (≤ 40 chars), color, collapsed }. */
function cleanGroup(g = {}) {
  return {
    title: String(g.title || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    color: COLORS.includes(g.color) ? g.color : COLORS[0],
    collapsed: !!g.collapsed,
  };
}

module.exports = { COLORS, COLOR_HEX, normalizeOrder, nextColor, cleanGroup };

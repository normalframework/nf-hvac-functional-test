'use strict';

const { getRole, roleFitsEquipment } = require('../roles');
const { loadHaystackMap } = require('./map');

const MARKER_VALUES = new Set(['m:', 'M', 'marker', true]);

/**
 * @param {Set<string>} tags
 * @param {unknown} raw
 */
function addTagList(tags, raw) {
  const parts = Array.isArray(raw) ? raw : [raw];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    for (const token of part.split(',')) {
      const tag = token.trim().toLowerCase();
      if (tag) tags.add(tag);
    }
  }
}

/**
 * @param {any} point
 * @returns {Set<string>}
 */
function pointTags(point) {
  const tags = new Set();
  if (Array.isArray(point.tags)) addTagList(tags, point.tags);
  const attrs = point.attrs && typeof point.attrs === 'object' ? point.attrs : {};
  for (const [key, value] of Object.entries(attrs)) {
    const name = key.toLowerCase();
    if (name === 'markers' || name === 'class') {
      addTagList(tags, value);
      if (name === 'class' && typeof value === 'string') {
        for (const token of value.split(',')) {
          for (const part of token.split('-')) {
            const tag = part.trim().toLowerCase();
            if (tag) tags.add(tag);
          }
        }
      }
      continue;
    }
    if (MARKER_VALUES.has(value)) tags.add(name);
  }
  return tags;
}

/**
 * Longest tag set wins. A `cmd` marker keeps only command entries.
 * An equal-length tie matches nothing and is reported.
 * @param {Set<string>} tags
 * @param {any} map
 * @returns {{ entry: any, ambiguous: boolean, roles: string[] }}
 */
function matchRoleResult(tags, map) {
  /** @type {{ entry: any, score: number }[]} */
  const candidates = [];
  for (const entry of map.roles) {
    const need = entry.tags.map((tag) => String(tag).toLowerCase());
    if (!need.every((tag) => tags.has(tag))) continue;
    const forbid = Array.isArray(entry.forbid) ? entry.forbid.map((tag) => String(tag).toLowerCase()) : [];
    if (forbid.some((tag) => tags.has(tag))) continue;
    candidates.push({ entry, score: need.length });
  }
  const pool = tags.has('cmd')
    ? candidates.filter((item) => item.entry.tags.some((tag) => String(tag).toLowerCase() === 'cmd'))
    : candidates;
  if (pool.length === 0) return { entry: null, ambiguous: false, roles: [] };
  const bestScore = Math.max(...pool.map((item) => item.score));
  const best = pool.filter((item) => item.score === bestScore);
  const roles = best.map((item) => item.entry.role);
  if (best.length > 1) return { entry: null, ambiguous: true, roles };
  return { entry: best[0].entry, ambiguous: false, roles };
}

/**
 * @param {Set<string>} tags
 * @param {any} map
 */
function matchRole(tags, map) {
  return matchRoleResult(tags, map).entry;
}

/**
 * @param {Set<string>} tags
 * @param {any} map
 * @returns {'ahu' | 'vav' | null}
 */
function typeFromTags(tags, map) {
  const table = map.equipment_tags || {};
  for (const kind of ['ahu', 'vav']) {
    const markers = table[kind] || [];
    if (markers.some((tag) => tags.has(String(tag).toLowerCase()))) return /** @type {'ahu' | 'vav'} */ (kind);
  }
  return null;
}

/**
 * @param {any[]} points
 * @returns {'ahu' | 'vav' | null}
 */
function typeFromRoles(points) {
  for (const point of points) {
    const role = getRole(point.role);
    if (role) return Array.isArray(role.equipment) ? role.equipment[0] : role.equipment;
  }
  return null;
}

/**
 * @param {any} input
 * @param {any} [map]
 */
function loadHaystackModel(input, map) {
  const roleMap = map || loadHaystackMap();
  const markers = new Set((roleMap.writable_markers || ['writable']).map((tag) => String(tag).toLowerCase()));
  /** @type {{ uuid: string | null, equip: string, roles: string[], tags: string[] }[]} */
  const ambiguous = [];
  /** @type {{ equipment_id: string, role: string, equipment_type: string }[]} */
  const rejected = [];
  /** @type {Map<string, any>} */
  const equipment = new Map();

  /**
   * @param {string} id
   */
  function ensure(id) {
    if (!equipment.has(id)) {
      equipment.set(id, { id, type: null, serves: [], ahuRef: null, points: {}, tags: [] });
    }
    return equipment.get(id);
  }

  for (const record of input.equipment || []) {
    const item = ensure(String(record.id));
    const tags = pointTags(record);
    item.tags = [...tags];
    item.type = record.type || typeFromTags(tags, roleMap);
    if (typeof record.ahuRef === 'string') item.ahuRef = record.ahuRef;
    if (Array.isArray(record.serves)) item.serves = record.serves.map(String);
  }

  for (const point of input.points || []) {
    const tags = pointTags(point);
    const equipId = point.equipRef || point.equip_id || (point.attrs && point.attrs.equipRef);
    if (!equipId) continue;
    const item = ensure(String(equipId));
    const matched = matchRoleResult(tags, roleMap);
    if (matched.ambiguous) {
      ambiguous.push({
        uuid: point.uuid || (point.attrs && point.attrs.uuid) || null,
        equip: String(equipId),
        roles: matched.roles.slice().sort(),
        tags: [...tags].sort(),
      });
      continue;
    }
    if (!matched.entry) continue;
    if (item.points[matched.entry.role]) {
      ambiguous.push({
        uuid: point.uuid || (point.attrs && point.attrs.uuid) || null,
        equip: String(equipId),
        roles: [matched.entry.role],
        tags: [...tags].sort(),
      });
      delete item.points[matched.entry.role];
      continue;
    }
    const unit = point.unit || (point.attrs && (point.attrs.unit || point.attrs.units)) || null;
    item.points[matched.entry.role] = {
      role: matched.entry.role,
      uuid: point.uuid || (point.attrs && point.attrs.uuid) || null,
      layer: point.layer || (point.attrs && point.attrs.layer) || null,
      unit: typeof unit === 'string' && unit ? unit : null,
      writable: [...markers].some((marker) => tags.has(marker)),
      tags: [...tags],
    };
    const ahuRef = point.ahuRef || (point.attrs && typeof point.attrs.ahuRef === 'string' ? point.attrs.ahuRef : null);
    if (typeof ahuRef === 'string') item.ahuRef = ahuRef;
  }

  for (const item of equipment.values()) {
    if (!item.type) item.type = typeFromRoles(Object.values(item.points));
    if (item.ahuRef) {
      const ahu = ensure(item.ahuRef);
      if (!ahu.serves.includes(item.id)) ahu.serves.push(item.id);
    }
    for (const point of Object.values(item.points)) {
      const typed = /** @type {{ role: string }} */ (point);
      const role = getRole(typed.role);
      if (role && item.type && !roleFitsEquipment(role, item.type)) {
        rejected.push({ equipment_id: item.id, role: typed.role, equipment_type: item.type });
        delete item.points[typed.role];
      }
    }
  }

  return { source: 'haystack', equipment: [...equipment.values()], ambiguous, rejected };
}

module.exports = { loadHaystackModel, pointTags, matchRole, matchRoleResult };

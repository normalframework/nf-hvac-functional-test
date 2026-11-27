'use strict';

/**
 * Points the operator marked writable. This is the only write allow-list.
 * @param {{ equipment?: { id: string, points?: Record<string, { writable?: boolean, uuid?: string, layer?: string }> }[] }} config
 */
function writableAllowList(config) {
  /** @type {{ equipment_id: string, role: string, uuid: string | null, layer: string | null }[]} */
  const list = [];
  const equipment = Array.isArray(config.equipment) ? config.equipment : [];
  for (const item of equipment) {
    const points = item.points || {};
    for (const [role, binding] of Object.entries(points)) {
      if (binding && binding.writable === true) {
        list.push({
          equipment_id: item.id,
          role,
          uuid: typeof binding.uuid === 'string' ? binding.uuid : null,
          layer: typeof binding.layer === 'string' ? binding.layer : null,
        });
      }
    }
  }
  return list;
}

/**
 * @param {{ equipment?: { id: string, points?: Record<string, { writable?: boolean }> }[] }} config
 * @param {string} equipmentId
 * @param {string} role
 */
function isOnAllowList(config, equipmentId, role) {
  return writableAllowList(config).some((entry) => entry.equipment_id === equipmentId && entry.role === role);
}

module.exports = { writableAllowList, isOnAllowList };

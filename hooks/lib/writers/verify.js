'use strict';

/**
 * Unwrap one priority-array element. An unrecognized shape is unreadable.
 * @param {unknown} value
 * @returns {number | boolean | string | null | undefined}
 */
function unwrapSlot(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    if (Object.prototype.hasOwnProperty.call(record, 'null')) return null;
    if (Object.prototype.hasOwnProperty.call(record, 'real') && typeof record.real === 'number') return record.real;
    if (Object.prototype.hasOwnProperty.call(record, 'boolean') && typeof record.boolean === 'boolean') return record.boolean;
    if (Object.prototype.hasOwnProperty.call(record, 'enum') && (typeof record.enum === 'string' || typeof record.enum === 'number')) {
      return record.enum;
    }
  }
  return undefined;
}

/**
 * @param {unknown} slots
 * @returns {(number | boolean | string | null)[] | 'unreadable'}
 */
function parsePriorityArray(slots) {
  if (!Array.isArray(slots) || slots.length < 16) return 'unreadable';
  /** @type {(number | boolean | string | null)[]} */
  const parsed = [];
  for (const slot of slots) {
    const value = unwrapSlot(slot);
    if (value === undefined) return 'unreadable';
    parsed.push(value);
  }
  return parsed;
}

/**
 * @param {InstanceType<typeof import('../nf/client').NfClient>} client
 * @param {{ uuid: string }} entry
 * @returns {Promise<(number | boolean | string | null)[] | 'unreadable'>}
 */
async function readArray(client, entry) {
  const reply = await client.bacnetRead([{ uuid: entry.uuid, property: 'PRIORITY_ARRAY' }]);
  if (!reply || (reply.errors && reply.errors.length)) return 'unreadable';
  const slots = reply.results && reply.results[0] ? reply.results[0].value : null;
  return parsePriorityArray(slots);
}

/**
 * @param {InstanceType<typeof import('../nf/client').NfClient>} client
 * @param {{ uuid: string, priority: number }} entry
 * @returns {Promise<'empty' | 'held' | 'unreadable'>}
 */
async function readSlot(client, entry) {
  const slots = await readArray(client, entry);
  if (slots === 'unreadable') return 'unreadable';
  const value = slots[entry.priority - 1];
  if (value === null) return 'empty';
  return 'held';
}

/**
 * @param {number | boolean | string | null | undefined} left
 * @param {number | boolean | string | null | undefined} right
 */
function sameValue(left, right) {
  return left === right;
}

/**
 * Relinquish only when the slot still holds the value we wrote.
 * Unreadable is not released. A different value is left alone.
 * @param {InstanceType<typeof import('../nf/client').NfClient>} client
 * @param {{ uuid: string, priority: number, value: number | boolean | string | null }} entry
 * @returns {Promise<'released' | 'empty' | 'unreadable' | 'slot_taken_by_other' | 'write_failed'>}
 */
async function relinquishIfOurs(client, entry) {
  const slots = await readArray(client, entry);
  if (slots === 'unreadable') return 'unreadable';
  const current = slots[entry.priority - 1];
  if (current === null) return 'empty';
  if (!sameValue(current, entry.value)) return 'slot_taken_by_other';
  const reply = await client.bacnetWrite({
    uuid: entry.uuid,
    priority: entry.priority,
    value: null,
  });
  if (reply.errors && reply.errors.length) return 'write_failed';
  const after = await readArray(client, entry);
  if (after === 'unreadable') return 'unreadable';
  if (after[entry.priority - 1] !== null) return 'write_failed';
  return 'released';
}

/**
 * @param {number | boolean | string | null} value
 */
function encodeValue(value) {
  if (value === null) return { null: 0 };
  if (typeof value === 'boolean') return { boolean: value };
  if (typeof value === 'number') return { real: value };
  return { enum: value };
}

module.exports = {
  unwrapSlot,
  parsePriorityArray,
  readArray,
  readSlot,
  sameValue,
  relinquishIfOurs,
  encodeValue,
};

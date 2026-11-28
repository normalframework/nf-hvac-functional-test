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
    if (Object.prototype.hasOwnProperty.call(record, 'enumerated') && typeof record.enumerated === 'number') return record.enumerated;
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
  const slots = await client.readPriorityArray(entry);
  return slots ? parsePriorityArray(slots) : 'unreadable';
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
  encodeValue,
};

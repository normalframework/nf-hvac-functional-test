'use strict';

/**
 * @param {{ ledger: InstanceType<typeof import('../ledger').Ledger>, writer: { release: (entries: any[]) => Promise<{ verified: any[], failed: any[] }> }, entries: any[], retries: number, backoff_s: number[], sleep: (ms: number) => Promise<void>, once?: boolean }} options
 */
async function releaseEntries(options) {
  if (options.once) return releaseOnce(options);
  let pending = options.entries.slice();
  let attempts = 0;
  while (pending.length) {
    const result = await options.writer.release(pending);
    for (const entry of result.verified) {
      options.ledger.append({
        kind: 'released',
        run_id: entry.run_id,
        equipment_id: entry.equipment_id,
        uuid: entry.uuid,
        layer: entry.layer,
        priority: entry.priority,
        backend: entry.backend,
        release_verified: true,
      });
    }
    pending = result.failed;
    if (!pending.length) return { ok: true, attempts, needsAttention: false, pending };
    if (attempts >= options.retries) {
      return { ok: false, attempts, needsAttention: true, pending };
    }
    const delay = options.backoff_s[attempts] ?? options.backoff_s[options.backoff_s.length - 1];
    await options.sleep(delay * 1000);
    attempts += 1;
  }
  return { ok: true, attempts, needsAttention: false, pending };
}

/**
 * Release anything the ledger still has open, then cancel leftover ftest commands.
 * @param {{ ledger: InstanceType<typeof import('../ledger').Ledger>, writers: Record<string, any>, client?: InstanceType<typeof import('../nf/client').NfClient> | null, retries: number, backoff_s: number[], sleep: (ms: number) => Promise<void>, keepRunId?: string, onlyRunId?: string }} options
 */
async function recover(options) {
  const open = options.ledger.openOverrides().filter((entry) => {
    if (options.keepRunId && entry.run_id === options.keepRunId) return false;
    if (options.onlyRunId && entry.run_id !== options.onlyRunId) return false;
    return true;
  });
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const entry of open) {
    const backend = entry.backend || 'nf_command';
    const group = groups.get(backend) || [];
    group.push(entry);
    groups.set(backend, group);
  }
  let needsAttention = false;
  for (const [backend, entries] of groups) {
    const writer = options.writers[backend];
    if (!writer) {
      needsAttention = true;
      continue;
    }
    const result = await releaseEntries({
      ledger: options.ledger,
      writer,
      entries,
      retries: options.retries,
      backoff_s: options.backoff_s,
      sleep: options.sleep,
    });
    if (!result.ok) needsAttention = true;
  }
  if (options.client) await cancelOrphanCommands(options.ledger, options.client);
  await restorePeriods(options.ledger, options.client);
  return { needsAttention, open: options.ledger.openOverrides() };
}

/**
 * @param {InstanceType<typeof import('../ledger').Ledger>} ledger
 * @param {InstanceType<typeof import('../nf/client').NfClient>} client
 */
async function cancelOrphanCommands(ledger, client) {
  const listed = await client.listCommands();
  const openNames = new Set(ledger.openOverrides().map((entry) => entry.command_name).filter(Boolean));
  for (const command of listed.commands || []) {
    if (!String(command.name).startsWith('ftest-')) continue;
    if (openNames.has(command.name)) continue;
    await client.cancelCommand(command.id);
  }
}

/**
 * @param {InstanceType<typeof import('../ledger').Ledger>} ledger
 * @param {InstanceType<typeof import('../nf/client').NfClient> | null | undefined} client
 */
async function restorePeriods(ledger, client) {
  const pending = ledger.openPeriods();
  if (!pending.length || !client) return;
  await client.upsertPoints(pending.map((entry) => ({
    uuid: entry.uuid,
    layer: entry.layer,
    period: entry.original_period,
  })));
  for (const entry of pending) {
    ledger.append({
      kind: 'period_restored',
      uuid: entry.uuid,
      layer: entry.layer,
      run_id: entry.run_id,
      original_period: entry.original_period,
    });
  }
}

/**
 * One attempt and no sleep. The caller waits until the next tick.
 * @param {any} options
 */
async function releaseOnce(options) {
  const result = await options.writer.release(options.entries.slice());
  for (const entry of result.verified || []) {
    options.ledger.append({
      kind: 'released',
      run_id: entry.run_id,
      equipment_id: entry.equipment_id,
      uuid: entry.uuid,
      layer: entry.layer,
      priority: entry.priority,
      backend: entry.backend,
      release_verified: true,
    });
  }
  const pending = result.failed || [];
  if (!pending.length) return { ok: true, attempts: 0, needsAttention: false, pending, wait_ms: 0, deferred: false };
  const delay = options.backoff_s && options.backoff_s.length ? options.backoff_s[0] : 1;
  return { ok: false, attempts: 0, needsAttention: false, pending, wait_ms: delay * 1000, deferred: true };
}

module.exports = { releaseEntries, recover };

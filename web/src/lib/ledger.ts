/**
 * The ledger a chat is using: its open one, else the newest. A chat can have several (one closes when it worked, a new
 * one opens if it breaks again); the first by id could be a closed one, and edits to it missed the ledger the hub used.
 */
export function currentLedger<T extends { fields: Record<string, unknown>; updated_at: string }>(ledgers: T[]): T | undefined {
  const open = ledgers.filter((l) => l.fields.open !== false);
  const pool = open.length ? open : ledgers;
  return [...pool].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

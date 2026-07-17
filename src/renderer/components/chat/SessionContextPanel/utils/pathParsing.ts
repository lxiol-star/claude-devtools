/**
 * Path parsing utilities for SessionContextPanel.
 */

/** Translate function shape accepted from the i18n hook. */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Format the firstSeenInGroup value into a human-readable string.
 * Converts "ai-0" -> "Turn 1", "ai-1" -> "Turn 2", etc.
 */
export function formatFirstSeen(groupId: string, t: Translate): string {
  const turnIndex = parseTurnIndex(groupId);
  if (turnIndex < 0) return groupId;
  return t('chat.turn', { turn: turnIndex + 1 });
}

/**
 * Extract turn index from groupId. Returns -1 if invalid.
 * "ai-0" -> 0, "ai-1" -> 1, etc.
 */
export function parseTurnIndex(groupId: string): number {
  const match = /^ai-(\d+)$/.exec(groupId);
  if (!match) return -1;
  return parseInt(match[1], 10);
}

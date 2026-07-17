/**
 * Shared helper for composing session annotation keys.
 *
 * Session annotations are keyed by a composite string that uniquely identifies
 * a session across contexts (`${contextId}:${projectId}:${sessionId}`). This
 * lives in a shared module so the main process (ConfigManager) and the renderer
 * (store) build the exact same key.
 */

/**
 * Builds the composite key used to store a session annotation.
 * @param contextId - Service context id; falls back to 'local' when undefined
 * @param projectId - The project id
 * @param sessionId - The session id
 * @returns Composite key `${contextId}:${projectId}:${sessionId}`
 */
export function buildAnnotationKey(
  contextId: string | undefined,
  projectId: string,
  sessionId: string
): string {
  return `${contextId ?? 'local'}:${projectId}:${sessionId}`;
}

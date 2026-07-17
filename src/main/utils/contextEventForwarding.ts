/**
 * Context-tagged file-change forwarding rules.
 *
 * Every local-type ServiceContext keeps its FileWatcher running so the
 * aggregate "All" view can live-update from any backend. The ACTIVE context's
 * events already flow through the untagged 'file-change' wiring, so they must
 * not be forwarded again on the context-tagged channel (each refresh would
 * run twice).
 */

/**
 * Whether a file-change event from `sourceContextId` should be forwarded on
 * the context-tagged channel. Returns false when the source is the active
 * context — its events already arrive via the untagged 'file-change' wiring.
 */
export function shouldForwardContextFileChange(
  activeContextId: string,
  sourceContextId: string
): boolean {
  return activeContextId !== sourceContextId;
}

/**
 * contextEventForwarding unit tests.
 *
 * Covers the active-context dedup guard for context-tagged file-change
 * forwarding: the active context's events already flow through the untagged
 * 'file-change' wiring, so forwarding them tagged too would double every
 * renderer refresh.
 */

import { describe, expect, it } from 'vitest';

import { shouldForwardContextFileChange } from '@main/utils/contextEventForwarding';

describe('shouldForwardContextFileChange', () => {
  it('forwards events from inactive local contexts', () => {
    expect(shouldForwardContextFileChange('local', 'local-kimi')).toBe(true);
    expect(shouldForwardContextFileChange('local-kimi', 'local')).toBe(true);
    expect(shouldForwardContextFileChange('local-kimi', 'local-codex')).toBe(true);
  });

  it('forwards local context events while an SSH context is active', () => {
    // The renderer ignores these outside aggregate mode, but forwarding keeps
    // the rule uniform: only the active context is deduped.
    expect(shouldForwardContextFileChange('ssh-myserver', 'local')).toBe(true);
  });

  it('skips events from the active context (already on the untagged channel)', () => {
    expect(shouldForwardContextFileChange('local', 'local')).toBe(false);
    expect(shouldForwardContextFileChange('local-kimi', 'local-kimi')).toBe(false);
    expect(shouldForwardContextFileChange('ssh-myserver', 'ssh-myserver')).toBe(false);
  });
});

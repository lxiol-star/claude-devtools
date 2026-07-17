/**
 * UI slice - manages command palette and sidebar state.
 */

import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import type { AppState } from '../types';
import type { SourceFilter } from './contextSlice';
import type { SavedView } from '@renderer/types/data';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:ui');

// =============================================================================
// Slice Interface
// =============================================================================

export interface UISlice {
  // State
  commandPaletteOpen: boolean;
  sidebarCollapsed: boolean;
  // Sidebar annotation filter (client-side): sessions must carry ALL selected
  // tags and a score >= annotationMinScore. Empty tags + 0 score = no filter.
  annotationFilterTags: string[];
  annotationMinScore: number;
  // Saved views (named filter presets) loaded from config.
  savedViews: SavedView[];

  // Actions
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleSidebar: () => void;
  toggleAnnotationFilterTag: (tag: string) => void;
  setAnnotationMinScore: (score: number) => void;
  clearAnnotationFilter: () => void;
  /** Load saved views from config into local state */
  loadSavedViews: () => Promise<void>;
  /** Save the current filter state (tags + score + source) as a named view */
  saveCurrentView: (name: string) => Promise<void>;
  /** Delete a saved view by id */
  deleteSavedView: (id: string) => Promise<void>;
  /** Apply a saved view's filter state to the sidebar */
  applySavedView: (id: string) => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set, get) => ({
  // Initial state
  commandPaletteOpen: false,
  sidebarCollapsed: false,
  annotationFilterTags: [],
  annotationMinScore: 0,
  savedViews: [],

  // Command palette actions
  openCommandPalette: () => {
    set({ commandPaletteOpen: true });
  },

  closeCommandPalette: () => {
    set({ commandPaletteOpen: false });
  },

  // Sidebar actions
  toggleSidebar: () => {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
  },

  // Annotation filter actions (client-side sidebar filtering)
  toggleAnnotationFilterTag: (tag: string) => {
    set((state) => ({
      annotationFilterTags: state.annotationFilterTags.includes(tag)
        ? state.annotationFilterTags.filter((t) => t !== tag)
        : [...state.annotationFilterTags, tag],
    }));
  },

  setAnnotationMinScore: (score: number) => {
    set({ annotationMinScore: score });
  },

  clearAnnotationFilter: () => {
    set({ annotationFilterTags: [], annotationMinScore: 0 });
  },

  // Saved view actions (named filter presets, config-backed)
  loadSavedViews: async () => {
    try {
      const config = await api.config.get();
      set({ savedViews: config.sessions?.savedViews ?? [] });
    } catch (error) {
      logger.error('loadSavedViews error:', error);
      set({ savedViews: [] });
    }
  },

  saveCurrentView: async (name: string) => {
    const state = get();
    try {
      const created = await api.config.addSavedView({
        name,
        tags: state.annotationFilterTags,
        minScore: state.annotationMinScore,
        sourceFilter: state.sourceFilter,
      });
      // Optimistically append the created view returned by the main process.
      set({ savedViews: [...get().savedViews, created] });
    } catch (error) {
      logger.error('saveCurrentView error:', error);
    }
  },

  deleteSavedView: async (id: string) => {
    const previous = get().savedViews;
    set({ savedViews: previous.filter((v) => v.id !== id) });
    try {
      await api.config.removeSavedView(id);
    } catch (error) {
      // Rollback on failure
      set({ savedViews: previous });
      logger.error('deleteSavedView error:', error);
    }
  },

  applySavedView: (id: string) => {
    const view = get().savedViews.find((v) => v.id === id);
    if (!view) return;

    set({ annotationFilterTags: view.tags, annotationMinScore: view.minScore });
    // The source filter lives in the context slice.
    get().setSourceFilter(view.sourceFilter as SourceFilter);
  },
});

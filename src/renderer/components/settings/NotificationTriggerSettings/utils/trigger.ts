/**
 * Utility functions for notification triggers.
 */

import { generateUUID } from '@renderer/utils/stringUtils';

import type { NotificationTrigger, TriggerContentType, TriggerMode } from '@renderer/types/data';

/**
 * Generates a UUID v4 for new triggers.
 */
export function generateId(): string {
  return generateUUID();
}

/**
 * Get available match fields based on content type and tool name.
 * Labels are i18n keys resolved at render time.
 */
export function getAvailableMatchFields(
  contentType: TriggerContentType,
  toolName?: string
): { value: string; labelKey: string }[] {
  if (contentType === 'tool_result') {
    return [{ value: 'content', labelKey: 'settings.notifications.matchFieldOption.content' }];
  }

  if (contentType === 'thinking') {
    return [
      { value: 'thinking', labelKey: 'settings.notifications.matchFieldOption.thinkingContent' },
    ];
  }

  if (contentType === 'text') {
    return [{ value: 'text', labelKey: 'settings.notifications.matchFieldOption.textContent' }];
  }

  if (contentType === 'tool_use') {
    switch (toolName) {
      case 'Bash':
        return [
          { value: 'command', labelKey: 'settings.notifications.matchFieldOption.command' },
          { value: 'description', labelKey: 'settings.notifications.matchFieldOption.description' },
        ];
      case 'Task':
        return [
          { value: 'description', labelKey: 'settings.notifications.matchFieldOption.description' },
          { value: 'prompt', labelKey: 'settings.notifications.matchFieldOption.prompt' },
          {
            value: 'subagent_type',
            labelKey: 'settings.notifications.matchFieldOption.subagentType',
          },
        ];
      case 'Read':
      case 'Write':
        return [{ value: 'file_path', labelKey: 'settings.notifications.matchFieldOption.filePath' }];
      case 'Edit':
        return [
          { value: 'file_path', labelKey: 'settings.notifications.matchFieldOption.filePath' },
          { value: 'old_string', labelKey: 'settings.notifications.matchFieldOption.oldString' },
          { value: 'new_string', labelKey: 'settings.notifications.matchFieldOption.newString' },
        ];
      case 'Glob':
        return [
          { value: 'pattern', labelKey: 'settings.notifications.matchFieldOption.pattern' },
          { value: 'path', labelKey: 'settings.notifications.matchFieldOption.path' },
        ];
      case 'Grep':
        return [
          { value: 'pattern', labelKey: 'settings.notifications.matchFieldOption.pattern' },
          { value: 'path', labelKey: 'settings.notifications.matchFieldOption.path' },
          { value: 'glob', labelKey: 'settings.notifications.matchFieldOption.globFilter' },
        ];
      case 'WebFetch':
        return [
          { value: 'url', labelKey: 'settings.notifications.matchFieldOption.url' },
          { value: 'prompt', labelKey: 'settings.notifications.matchFieldOption.prompt' },
        ];
      case 'WebSearch':
        return [{ value: 'query', labelKey: 'settings.notifications.matchFieldOption.query' }];
      case 'Skill':
        return [
          { value: 'skill', labelKey: 'settings.notifications.matchFieldOption.skillName' },
          { value: 'args', labelKey: 'settings.notifications.matchFieldOption.arguments' },
        ];
      default:
        // "Any Tool" - match against the entire JSON-serialized input
        return [
          { value: '', labelKey: 'settings.notifications.matchFieldOption.fullInputJson' },
        ];
    }
  }

  return [];
}

/**
 * Derive the effective mode from trigger configuration for backward compatibility.
 */
export function deriveMode(trigger: NotificationTrigger): TriggerMode {
  if (trigger.mode) return trigger.mode;
  // Backward compatibility: if requireError is true and no mode, default to error_status
  if (trigger.requireError && trigger.contentType === 'tool_result') {
    return 'error_status';
  }
  return 'content_match';
}

/**
 * Validates a regex pattern.
 * @returns null if valid, error message if invalid
 */
export function validateRegexPattern(pattern: string): string | null {
  if (!pattern) {
    return null;
  }
  try {
    new RegExp(pattern);
    return null;
  } catch {
    return 'Invalid regex pattern';
  }
}

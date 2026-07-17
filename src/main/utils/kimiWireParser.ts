/**
 * Kimi Code wire.jsonl parser.
 *
 * Converts Kimi Code's event stream into claude-devtools' ParsedMessage model.
 */

import { createLogger } from '@shared/utils/logger';
import * as readline from 'readline';

import type { FileSystemProvider } from '@main/services/infrastructure/FileSystemProvider';
import type {
  ContentBlock,
  ParsedMessage,
  SessionFileMetadata,
  ToolCall,
  ToolResult,
} from '@main/types';
import type {
  KimiConfigUpdateEvent,
  KimiContentPart,
  KimiContentPartEvent,
  KimiContextApplyCompactionEvent,
  KimiGoalCreateEvent,
  KimiGoalUpdateEvent,
  KimiLoopEvent,
  KimiPermissionSetModeEvent,
  KimiSwarmModeEnterEvent,
  KimiToolCallEvent,
  KimiToolResultEvent,
  KimiTopLevelEvent,
  KimiTurnPromptEvent,
} from '@main/types/kimiWire';

const logger = createLogger('Util:kimiWireParser');

// =============================================================================
// Parsing entry points
// =============================================================================

export async function parseKimiWireFile(
  filePath: string,
  fsProvider: FileSystemProvider
): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = [];

  if (!(await fsProvider.exists(filePath))) {
    return messages;
  }

  const fileStream = fsProvider.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const events: KimiTopLevelEvent[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as KimiTopLevelEvent;
      events.push(parsed);
    } catch (error) {
      logger.error(`Error parsing line in ${filePath}:`, error);
    }
  }

  return aggregateKimiEvents(events);
}

export function aggregateKimiEvents(events: KimiTopLevelEvent[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  // Track current assistant state
  let currentAssistantMessage: ParsedMessage | null = null;
  let currentRequestId: string | undefined;
  let currentModel: string | undefined;

  // Map toolCallId -> { assistantUuid, toolUseId } for linking results
  const toolCallMap = new Map<string, { assistantUuid: string; toolUseId: string }>();

  for (const event of events) {
    const timestamp = event.time ? new Date(event.time) : new Date();

    switch (event.type) {
      case 'turn.prompt': {
        // Finish any in-progress assistant message before starting a new turn
        flushAssistant();

        const userMsg = buildUserMessage(event, timestamp);
        if (userMsg) {
          messages.push(userMsg);
        }
        break;
      }

      case 'context.append_message': {
        // context.append_message mirrors what goes into the LLM context.
        // - role=user, origin.kind=user is a duplicate of turn.prompt; skip it.
        // - role=user, origin.kind=injection (e.g. system-reminder) is system-level
        //   injected text, not real user input.
        // - role=assistant is an assistant echo, handled by loop events already.
        const origin = (event.message.origin?.kind) ?? 'user';
        if (event.message.role === 'user' && origin === 'user') {
          // Already captured by turn.prompt.
          break;
        }
        if (event.message.role === 'user' && origin === 'injection') {
          // System-injected content (system-reminder, plan_mode reminders, etc.).
          flushAssistant();
          const text =
            typeof event.message.content === 'string'
              ? event.message.content
              : extractTextFromContentParts(event.message.content);
          if (text) {
            messages.push({
              uuid: `injection-${event.time ?? timestamp.getTime()}`,
              parentUuid: null,
              type: 'system',
              timestamp,
              role: 'system',
              content: text,
              isSidechain: false,
              isMeta: true,
              toolCalls: [],
              toolResults: [],
            });
          }
          break;
        }
        break;
      }

      case 'llm.request': {
        currentRequestId = `kimi-${event.time ?? Date.now()}`;
        currentModel = event.modelAlias ?? event.model;
        break;
      }

      case 'context.append_loop_event': {
        handleLoopEvent(event.event, timestamp);
        break;
      }

      case 'usage.record': {
        // Attach usage to the most recent assistant message if it has no usage yet
        const lastAssistant = findLastAssistant(messages);
        if (lastAssistant && !lastAssistant.usage) {
          lastAssistant.usage = {
            input_tokens: (event.usage.inputOther ?? 0) + (event.usage.inputCacheRead ?? 0),
            output_tokens: event.usage.output ?? 0,
            cache_read_input_tokens: event.usage.inputCacheRead ?? 0,
            cache_creation_input_tokens: event.usage.inputCacheCreation ?? 0,
          };
        }
        break;
      }

      case 'goal.create':
      case 'goal.update':
      case 'goal.clear':
      case 'plan_mode.enter':
      case 'plan_mode.exit':
      case 'plan_mode.cancel':
      case 'swarm_mode.enter':
      case 'swarm_mode.exit':
      case 'full_compaction.begin':
      case 'full_compaction.complete':
      case 'context.apply_compaction':
      case 'config.update':
      case 'tools.set_active_tools':
      case 'permission.set_mode':
      case 'permission.record_approval_result':
      case 'mcp.tools_discovered':
      case 'tools.update_store':
      case 'metadata': {
        // Surface lightweight system messages for mode/goal/compaction events.
        // These help the UI show when plan mode, swarm mode, or compaction happened.
        const systemMsg = buildSystemMessage(event.type, event, timestamp);
        if (systemMsg) {
          messages.push(systemMsg);
        }
        break;
      }

      case 'turn.steer':
      case 'turn.cancel':
      default: {
        // Ignore or handle future event types
        break;
      }
    }
  }

  flushAssistant();
  return messages;

  // ========================================================================
  // Loop event handling
  // ========================================================================

  function handleLoopEvent(event: KimiLoopEvent, timestamp: Date): void {
    switch (event.type) {
      case 'step.begin': {
        flushAssistant();
        currentAssistantMessage = createAssistantSkeleton(
          event.uuid,
          timestamp,
          currentModel,
          currentRequestId
        );
        break;
      }

      case 'content.part': {
        if (!currentAssistantMessage) {
          currentAssistantMessage = createAssistantSkeleton(
            event.stepUuid ?? event.uuid,
            timestamp,
            currentModel,
            currentRequestId
          );
        }
        appendContentPart(currentAssistantMessage, event);
        break;
      }

      case 'tool.call': {
        if (!currentAssistantMessage) {
          currentAssistantMessage = createAssistantSkeleton(
            event.stepUuid ?? event.uuid,
            timestamp,
            currentModel,
            currentRequestId
          );
        }
        const toolUseBlock = buildToolUseBlock(event);
        appendBlock(currentAssistantMessage, toolUseBlock);

        const toolCall: ToolCall = {
          id: event.toolCallId,
          name: event.name,
          input: event.args,
          isTask: event.name === 'Agent' || event.name === 'AgentSwarm',
        };
        currentAssistantMessage.toolCalls.push(toolCall);

        toolCallMap.set(event.toolCallId, {
          assistantUuid: currentAssistantMessage.uuid,
          toolUseId: event.toolCallId,
        });
        break;
      }

      case 'tool.result': {
        flushAssistant();
        const resultMsg = buildToolResultMessage(event, timestamp, toolCallMap);
        if (resultMsg) {
          messages.push(resultMsg);
        }
        break;
      }

      case 'step.end': {
        if (currentAssistantMessage && event.usage) {
          currentAssistantMessage.usage = {
            input_tokens: (event.usage.inputOther ?? 0) + (event.usage.inputCacheRead ?? 0),
            output_tokens: event.usage.output ?? 0,
            cache_read_input_tokens: event.usage.inputCacheRead ?? 0,
            cache_creation_input_tokens: event.usage.inputCacheCreation ?? 0,
          };
        }
        flushAssistant();
        break;
      }
    }
  }

  function flushAssistant(): void {
    if (!currentAssistantMessage) return;

    // Only keep assistant messages that have actual content or tool calls
    const hasContent =
      (typeof currentAssistantMessage.content === 'string' &&
        currentAssistantMessage.content.length > 0) ||
      (Array.isArray(currentAssistantMessage.content) &&
        currentAssistantMessage.content.length > 0);

    if (hasContent || currentAssistantMessage.toolCalls.length > 0) {
      messages.push(currentAssistantMessage);
    }

    currentAssistantMessage = null;
  }

  function findLastAssistant(msgs: ParsedMessage[]): ParsedMessage | null {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].type === 'assistant') {
        return msgs[i];
      }
    }
    return null;
  }
}

// =============================================================================
// Message builders
// =============================================================================

function buildUserMessage(event: KimiTurnPromptEvent, timestamp: Date): ParsedMessage | null {
  const text = extractTextFromContentParts(event.input);
  if (!text) return null;

  return {
    uuid: `user-${event.time ?? Date.now()}`,
    parentUuid: null,
    type: 'user',
    timestamp,
    role: 'user',
    content: text,
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
  };
}

function createAssistantSkeleton(
  uuid: string | undefined,
  timestamp: Date,
  model?: string,
  requestId?: string
): ParsedMessage {
  return {
    uuid: uuid ?? `assistant-${timestamp.getTime()}`,
    parentUuid: null,
    type: 'assistant',
    timestamp,
    role: 'assistant',
    content: [],
    model,
    requestId,
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
  };
}

function appendContentPart(msg: ParsedMessage, event: KimiContentPartEvent): void {
  const block = buildContentBlock(event.part);
  if (block) {
    appendBlock(msg, block);
  }
}

function buildContentBlock(part: KimiContentPart): ContentBlock | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return { type: 'thinking', thinking: part.think, signature: '' };
    case 'image':
      if (part.source?.type === 'base64' && part.source.data) {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: (part.source.media_type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp') ?? 'image/png',
            data: part.source.data,
          },
        };
      }
      return null;
    case 'tool_call':
      return {
        type: 'tool_use',
        id: part.id ?? `tool-${Date.now()}`,
        name: part.name ?? 'unknown',
        input: part.input ?? {},
      };
    case 'tool_result':
      // The authoritative tool result is delivered by the dedicated
      // `tool.result` loop event (stdout/stderr/exitCode/output). The
      // content.part variant is just a context echo and would duplicate it.
      return null;
    default:
      return null;
  }
}

function buildToolUseBlock(event: KimiToolCallEvent): ContentBlock {
  return {
    type: 'tool_use',
    id: event.toolCallId,
    name: event.name,
    input: event.args,
  };
}

function buildToolResultMessage(
  event: KimiToolResultEvent,
  timestamp: Date,
  toolCallMap: Map<string, { assistantUuid: string; toolUseId: string }>
): ParsedMessage | null {
  const result = event.result ?? {};
  let content: string | ContentBlock[] = '';

  if (typeof result.output === 'string') {
    content = result.output;
  } else if (typeof result.content === 'string') {
    content = result.content;
  } else if (result.stdout !== undefined || result.stderr !== undefined) {
    content = `stdout:\n${result.stdout ?? ''}\n\nstderr:\n${result.stderr ?? ''}`;
  } else if (result.output !== undefined) {
    content = JSON.stringify(result.output);
  } else if (result.content !== undefined) {
    content = JSON.stringify(result.content);
  } else {
    content = JSON.stringify(result);
  }

  const link = toolCallMap.get(event.toolCallId);

  return {
    uuid: `result-${event.toolCallId}`,
    parentUuid: link?.assistantUuid ?? null,
    type: 'user',
    timestamp,
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: event.toolCallId,
        content,
        is_error: event.is_error ?? false,
      },
    ],
    isSidechain: false,
    isMeta: true,
    sourceToolUseID: event.toolCallId,
    sourceToolAssistantUUID: link?.assistantUuid,
    toolCalls: [],
    toolResults: [
      {
        toolUseId: event.toolCallId,
        content,
        isError: event.is_error ?? false,
      } as ToolResult,
    ],
  };
}

function buildSystemMessage(
  type: string,
  event: KimiTopLevelEvent,
  timestamp: Date
): ParsedMessage | null {
  let text = '';

  switch (type) {
    case 'goal.create': {
      const goalEvent = event as KimiGoalCreateEvent;
      const goalSuffix = goalEvent.goalId ? `: ${goalEvent.goalId}` : '';
      text = `🎯 Goal created${goalSuffix}`;
      if (goalEvent.objective) {
        text += `\n${goalEvent.objective}`;
      }
      break;
    }
    case 'goal.update': {
      const updateEvent = event as KimiGoalUpdateEvent;
      const turnsSuffix = updateEvent.turnsUsed !== undefined ? ` (turns used: ${updateEvent.turnsUsed})` : '';
      text = `📝 Goal updated${turnsSuffix}`;
      break;
    }
    case 'goal.clear':
      text = '✅ Goal cleared';
      break;
    case 'plan_mode.enter':
      text = '📋 Entered plan mode';
      break;
    case 'plan_mode.exit':
      text = '✅ Exited plan mode';
      break;
    case 'plan_mode.cancel':
      text = '❌ Plan mode cancelled';
      break;
    case 'swarm_mode.enter': {
      const swarmEvent = event as KimiSwarmModeEnterEvent;
      const triggerSuffix = swarmEvent.trigger ? ` (${swarmEvent.trigger})` : '';
      text = `🐝 Entered swarm mode${triggerSuffix}`;
      break;
    }
    case 'swarm_mode.exit':
      text = '✅ Exited swarm mode';
      break;
    case 'full_compaction.begin':
      text = '📦 Context compaction started';
      break;
    case 'full_compaction.complete':
      text = '✅ Context compaction completed';
      break;
    case 'context.apply_compaction': {
      const compactionEvent = event as KimiContextApplyCompactionEvent;
      text = '📦 Context compacted';
      if (compactionEvent.summary) {
        text += `\n${compactionEvent.summary}`;
      }
      break;
    }
    case 'permission.set_mode': {
      const permissionEvent = event as KimiPermissionSetModeEvent;
      text = `🔐 Permission mode set to ${permissionEvent.mode}`;
      break;
    }
    case 'config.update': {
      const configEvent = event as KimiConfigUpdateEvent;
      const modelSuffix = configEvent.modelAlias ? ` (model: ${configEvent.modelAlias})` : '';
      text = `⚙️ Config updated${modelSuffix}`;
      break;
    }
    case 'tools.set_active_tools':
      text = '🛠️ Active tools updated';
      break;
    default:
      return null;
  }

  if (!text) return null;

  return {
    uuid: `system-${event.time ?? Date.now()}-${type}`,
    parentUuid: null,
    type: 'system',
    timestamp,
    role: 'system',
    content: text,
    isSidechain: false,
    isMeta: true,
    toolCalls: [],
    toolResults: [],
  };
}

// =============================================================================
// Helpers
// =============================================================================

function appendBlock(msg: ParsedMessage, block: ContentBlock): void {
  // ParsedMessage.content is intentionally mutable; normalize to array before appending.
  const contentArray: ContentBlock[] =
    typeof msg.content === 'string' ? [] : msg.content;
  contentArray.push(block);
  // eslint-disable-next-line no-param-reassign -- ParsedMessage uses mutable content array
  msg.content = contentArray;
}

function extractTextFromContentParts(parts: KimiContentPart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

// =============================================================================
// Metadata analysis
// =============================================================================

export async function analyzeKimiWireMetadata(
  filePath: string,
  fsProvider: FileSystemProvider
): Promise<SessionFileMetadata> {
  const messages = await parseKimiWireFile(filePath, fsProvider);

  let firstUserMessage: { text: string; timestamp: string } | null = null;
  let messageCount = 0;
  let hasDisplayableContent = false;
  let gitBranch: string | null = null;
  let isOngoing = false;

  for (const msg of messages) {
    if (msg.type === 'user' && !msg.isMeta) {
      if (!firstUserMessage) {
        const text = extractMessageText(msg);
        if (text) {
          firstUserMessage = {
            text: text.substring(0, 500),
            timestamp: msg.timestamp.toISOString(),
          };
        }
      }
    }

    if (msg.type === 'assistant' || (msg.type === 'user' && msg.isMeta)) {
      messageCount++;
    }

    if (!hasDisplayableContent && isDisplayableMessage(msg)) {
      hasDisplayableContent = true;
    }

    if (msg.gitBranch && !gitBranch) {
      gitBranch = msg.gitBranch;
    }
  }

  // Ongoing if the last meaningful message is an assistant without a final text block
  const last = messages[messages.length - 1];
  if (last?.type === 'assistant') {
    isOngoing = true;
  }

  return {
    firstUserMessage,
    messageCount,
    isOngoing,
    gitBranch,
    hasDisplayableContent,
  };
}

function extractMessageText(msg: ParsedMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function isDisplayableMessage(msg: ParsedMessage): boolean {
  // Hard noise types
  if (msg.type === 'system' || msg.type === 'summary' || msg.type === 'file-history-snapshot' || msg.type === 'queue-operation') {
    return false;
  }

  // Sidechain messages are subagents
  if (msg.isSidechain) {
    return false;
  }

  // Synthetic assistant messages
  if (msg.type === 'assistant' && msg.model === '<synthetic>') {
    return false;
  }

  // Assistant messages are displayable
  if (msg.type === 'assistant') {
    return true;
  }

  // Internal user messages (tool results) are displayable
  if (msg.type === 'user' && msg.isMeta) {
    return true;
  }

  // Real user input
  if (msg.type === 'user' && !msg.isMeta) {
    const text = extractMessageText(msg);
    return text.trim().length > 0;
  }

  return false;
}

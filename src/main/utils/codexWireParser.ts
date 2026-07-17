/**
 * Codex CLI session file parser.
 *
 * Converts Codex CLI's JSONL event stream into claude-devtools' ParsedMessage model.
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
  CodexContentPart,
  CodexCustomToolCallOutputItem,
  CodexFunctionCallOutputItem,
  CodexMessageItem,
  CodexTextContentPart,
  CodexTopLevelEvent,
} from '@main/types/codexWire';

const logger = createLogger('Util:codexWireParser');

// =============================================================================
// Parsing entry points
// =============================================================================

export async function parseCodexWireFile(
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

  const events: CodexTopLevelEvent[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CodexTopLevelEvent;
      events.push(parsed);
    } catch (error) {
      logger.error(`Error parsing line in ${filePath}:`, error);
    }
  }

  return aggregateCodexEvents(events);
}

export function aggregateCodexEvents(events: CodexTopLevelEvent[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  // Track session-level cwd/workspace from session_meta and turn_context
  let sessionCwd: string | null = null;
  let currentTurnCwd: string | null = null;
  const currentModel = '<codex>';

  // Map call_id -> { assistantUuid, toolUseId } for linking function outputs
  const callMap = new Map<string, { assistantUuid: string; toolUseId: string }>();

  // Track the last assistant message so function_call items can attach to it.
  let currentAssistant: ParsedMessage | null = null;

  for (const event of events) {
    const timestamp = new Date(event.timestamp);

    switch (event.type) {
      case 'session_meta': {
        const meta = (event).payload;
        sessionCwd = meta.cwd ?? sessionCwd;
        break;
      }

      case 'turn_context': {
        const ctx = (event).payload;
        currentTurnCwd = ctx.cwd ?? ctx.workspace_roots?.[0] ?? sessionCwd;
        break;
      }

      case 'response_item': {
        const item = event.payload;
        switch (item.type) {
          case 'message': {
            currentAssistant = null;
            const msg = buildMessageItem(item, timestamp, currentTurnCwd ?? sessionCwd);
            if (msg) {
              messages.push(msg);
              if (msg.type === 'assistant') {
                currentAssistant = msg;
              }
            }
            break;
          }

          case 'function_call': {
            const call = item;
            const toolCall: ToolCall = {
              id: call.call_id,
              name: call.name,
              input: parseFunctionArguments(call.arguments),
              isTask: call.name === 'agent' || call.name === 'Agent',
            };
            currentAssistant = attachToolCall(
              currentAssistant,
              toolCall,
              timestamp,
              currentModel,
              messages
            );
            callMap.set(call.call_id, {
              assistantUuid: currentAssistant.uuid,
              toolUseId: call.call_id,
            });
            break;
          }

          case 'function_call_output': {
            const output = item;
            const resultMsg = buildFunctionOutputMessage(output, timestamp, callMap);
            if (resultMsg) {
              messages.push(resultMsg);
              currentAssistant = null;
            }
            break;
          }

          case 'reasoning': {
            const reasoningMsg = buildReasoningMessage(item, timestamp);
            if (reasoningMsg) {
              messages.push(reasoningMsg);
              currentAssistant = null;
            }
            break;
          }

          case 'custom_tool_call': {
            // Newer Codex sessions drive tools (exec, browser, etc.) through
            // custom_tool_call / custom_tool_call_output instead of function_call.
            // Map them to the same tool_use / tool_result model so the UI renders
            // the tool call and its output.
            const call = item;
            const callId = call.call_id ?? call.id;
            if (!callId) break;
            const toolCall: ToolCall = {
              id: callId,
              name: call.name ?? 'tool',
              input: parseCustomToolInput(call.input),
              isTask: call.name === 'agent' || call.name === 'Agent',
            };
            currentAssistant = attachToolCall(
              currentAssistant,
              toolCall,
              timestamp,
              currentModel,
              messages
            );
            callMap.set(callId, {
              assistantUuid: currentAssistant.uuid,
              toolUseId: callId,
            });
            break;
          }

          case 'custom_tool_call_output': {
            const output = item;
            const resultMsg = buildCustomToolOutputMessage(output, timestamp, callMap);
            if (resultMsg) {
              messages.push(resultMsg);
              currentAssistant = null;
            }
            break;
          }

          case 'web_search_call': {
            // Surface a lightweight system message so the UI shows something.
            const sysMsg = buildSystemMessage(item.type, item, timestamp);
            if (sysMsg) {
              messages.push(sysMsg);
            }
            break;
          }
        }
        break;
      }

      case 'event_msg':
      case 'compacted': {
        // event_msg duplicates the response_item flow (task_started, user_message, task_complete).
        // We skip it to avoid duplicates; the response_item stream already captures messages.
        break;
      }
    }
  }

  return messages;
}

// =============================================================================
// Message builders
// =============================================================================

function buildMessageItem(
  item: CodexMessageItem,
  timestamp: Date,
  cwd: string | null
): ParsedMessage | null {
  const text = extractTextFromContentParts(item.content);

  if (item.role === 'developer') {
    // Developer instructions / system prompts are meta-level content.
    if (!text) return null;
    return {
      uuid: `developer-${timestamp.getTime()}`,
      parentUuid: null,
      type: 'system',
      timestamp,
      role: 'system',
      content: text,
      isSidechain: false,
      isMeta: true,
      cwd: cwd ?? undefined,
      toolCalls: [],
      toolResults: [],
    };
  }

  if (item.role === 'user') {
    if (!text) return null;
    return {
      uuid: `user-${timestamp.getTime()}`,
      parentUuid: null,
      type: 'user',
      timestamp,
      role: 'user',
      content: text,
      isSidechain: false,
      isMeta: false,
      cwd: cwd ?? undefined,
      toolCalls: [],
      toolResults: [],
    };
  }

  if (item.role === 'assistant') {
    return {
      uuid: `assistant-${timestamp.getTime()}`,
      parentUuid: null,
      type: 'assistant',
      timestamp,
      role: 'assistant',
      content: text ? [{ type: 'text', text }] : [],
      model: '<codex>',
      isSidechain: false,
      isMeta: false,
      cwd: cwd ?? undefined,
      toolCalls: [],
      toolResults: [],
    };
  }

  return null;
}

/**
 * Attach a tool call to the current assistant message, creating a synthetic
 * assistant skeleton when the tool call appears without a preceding assistant
 * message. Returns the assistant message the call was attached to.
 */
function attachToolCall(
  currentAssistant: ParsedMessage | null,
  toolCall: ToolCall,
  timestamp: Date,
  model: string,
  messages: ParsedMessage[]
): ParsedMessage {
  const toolUseBlock: ContentBlock = {
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
  };

  let assistant = currentAssistant;
  if (!assistant) {
    // Standalone tool call without a preceding assistant message:
    // create a synthetic assistant message to hold it.
    assistant = createAssistantSkeleton(`assistant-${toolCall.id}`, timestamp, model);
    messages.push(assistant);
  }

  appendBlock(assistant, toolUseBlock);
  assistant.toolCalls.push(toolCall);
  return assistant;
}

function buildFunctionOutputMessage(
  item: CodexFunctionCallOutputItem,
  timestamp: Date,
  callMap: Map<string, { assistantUuid: string; toolUseId: string }>
): ParsedMessage | null {
  return buildToolResultMessage(item.call_id, item.output, timestamp, callMap);
}

function buildCustomToolOutputMessage(
  item: CodexCustomToolCallOutputItem,
  timestamp: Date,
  callMap: Map<string, { assistantUuid: string; toolUseId: string }>
): ParsedMessage | null {
  if (!item.call_id) return null;
  return buildToolResultMessage(item.call_id, item.output, timestamp, callMap);
}

/**
 * Build a tool_result user message from a Codex tool output. The output can be
 * a plain string or an array of text content parts; both are normalized to a
 * displayable string.
 */
function buildToolResultMessage(
  callId: string,
  rawOutput: string | CodexContentPart[] | undefined,
  timestamp: Date,
  callMap: Map<string, { assistantUuid: string; toolUseId: string }>
): ParsedMessage {
  const link = callMap.get(callId);
  const content = normalizeToolOutput(rawOutput);

  return {
    uuid: `result-${callId}`,
    parentUuid: link?.assistantUuid ?? null,
    type: 'user',
    timestamp,
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: callId,
        content,
        is_error: false,
      },
    ],
    isSidechain: false,
    isMeta: true,
    sourceToolUseID: callId,
    sourceToolAssistantUUID: link?.assistantUuid,
    toolCalls: [],
    toolResults: [
      {
        toolUseId: callId,
        content,
        isError: false,
      } as ToolResult,
    ],
  };
}

/**
 * Strips a single surrounding `**...**` markdown-bold wrapper from a one-line
 * Codex reasoning headline. Only unwraps when the entire trimmed line is bold
 * (no inner `**`), so genuine emphasis inside longer text is left untouched.
 */
function stripBoldWrapper(text: string): string {
  const trimmed = (text ?? '').trim();
  const match = /^\*\*([^*][\s\S]*?)\*\*$/.exec(trimmed);
  if (match && !match[1].includes('**')) {
    return match[1].trim();
  }
  return trimmed;
}

function buildReasoningMessage(
  item: {
    summary?: { type: string; text: string }[];
    [key: string]: unknown;
  },
  timestamp: Date
): ParsedMessage | null {
  // Codex reasoning summaries are single headline lines wrapped in `**...**`
  // (e.g. "**Planning resilient GitHub API calls**"). The full chain-of-thought
  // is in the sibling `encrypted_content` and cannot be decrypted, so these
  // titles are all we have. Strip the bold wrapper so headers render as clean
  // text instead of leaking literal asterisks.
  const text = (item.summary?.map((s) => stripBoldWrapper(s.text)).join('\n') ?? '').trim();
  if (!text) return null;

  return {
    uuid: `reasoning-${timestamp.getTime()}`,
    parentUuid: null,
    type: 'assistant',
    timestamp,
    role: 'assistant',
    content: [{ type: 'thinking', thinking: text, signature: '' }],
    model: '<codex>',
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
  };
}

function buildSystemMessage(
  type: string,
  _item: { name?: string; [key: string]: unknown },
  timestamp: Date
): ParsedMessage | null {
  let text = '';
  switch (type) {
    case 'web_search_call':
      text = '🌐 Web search';
      break;
    default:
      return null;
  }

  return {
    uuid: `system-${timestamp.getTime()}-${type}`,
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

function parseFunctionArguments(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args !== 'string') {
    return args ?? {};
  }
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return { raw: args };
  }
}

/**
 * Parse the input of a custom_tool_call. Codex's "exec" harness sends the input
 * as a freeform JS snippet string rather than JSON, so fall back to a `code`
 * field when it isn't valid JSON object.
 */
function parseCustomToolInput(input: string | undefined): Record<string, unknown> {
  if (input === undefined) return {};
  if (typeof input !== 'string') {
    return input as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON — treat as a raw code/command snippet.
  }
  return { code: input };
}

/**
 * Normalize a Codex tool output into a displayable string. Outputs may be a
 * plain string or an array of text content parts (`{ type: 'input_text', text }`).
 */
function normalizeToolOutput(output: string | CodexContentPart[] | undefined): string {
  if (output === undefined) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return extractTextFromContentParts(output);
  }
  return String(output);
}

function extractTextFromContentParts(parts: CodexContentPart[] | undefined): string {
  if (!parts) return '';
  return parts
    .filter((p): p is CodexTextContentPart => p.type === 'output_text' || p.type === 'input_text' || p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function appendBlock(msg: ParsedMessage, block: ContentBlock): void {
  const contentArray: ContentBlock[] =
    typeof msg.content === 'string' ? [] : msg.content;
  contentArray.push(block);
  // eslint-disable-next-line no-param-reassign -- ParsedMessage uses mutable content array
  msg.content = contentArray;
}

function createAssistantSkeleton(
  uuid: string,
  timestamp: Date,
  model?: string
): ParsedMessage {
  return {
    uuid,
    parentUuid: null,
    type: 'assistant',
    timestamp,
    role: 'assistant',
    content: [],
    model,
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
  };
}

// =============================================================================
// Metadata analysis
// =============================================================================

export async function analyzeCodexWireMetadata(
  filePath: string,
  fsProvider: FileSystemProvider
): Promise<SessionFileMetadata> {
  const messages = await parseCodexWireFile(filePath, fsProvider);

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
  if (msg.type === 'system' || msg.type === 'summary' || msg.type === 'file-history-snapshot' || msg.type === 'queue-operation') {
    return false;
  }
  if (msg.isSidechain) {
    return false;
  }
  if (msg.type === 'assistant' && msg.model === '<synthetic>') {
    return false;
  }
  if (msg.type === 'assistant') {
    return true;
  }
  if (msg.type === 'user' && msg.isMeta) {
    return true;
  }
  if (msg.type === 'user' && !msg.isMeta) {
    const text = extractMessageText(msg);
    return text.trim().length > 0;
  }
  return false;
}

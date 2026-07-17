/**
 * Types for OpenAI Codex CLI session files.
 *
 * Codex CLI stores sessions as JSONL event streams in:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
 *
 * A separate index lives at ~/.codex/session_index.jsonl.
 */

// =============================================================================
// Index entry
// =============================================================================

export interface CodexSessionIndexEntry {
  id: string;
  thread_name: string;
  updated_at: string;
}

// =============================================================================
// Top-level event envelope
// =============================================================================

export interface CodexWireEvent {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface CodexSessionMetaEvent extends CodexWireEvent {
  type: 'session_meta';
  payload: {
    session_id: string;
    cwd?: string;
    workspace_roots?: string[];
    [key: string]: unknown;
  };
}

export interface CodexEventMessageEvent extends CodexWireEvent {
  type: 'event_msg';
  payload: {
    type: string;
    turn_id?: string;
    [key: string]: unknown;
  };
}

export interface CodexTurnContextEvent extends CodexWireEvent {
  type: 'turn_context';
  payload: {
    turn_id: string;
    cwd?: string;
    workspace_roots?: string[];
    [key: string]: unknown;
  };
}

export interface CodexResponseItemEvent extends CodexWireEvent {
  type: 'response_item';
  payload: CodexResponseItem;
}

export interface CodexCompactedEvent extends CodexWireEvent {
  type: 'compacted';
  payload: Record<string, unknown>;
}

export type CodexTopLevelEvent =
  | CodexSessionMetaEvent
  | CodexEventMessageEvent
  | CodexTurnContextEvent
  | CodexResponseItemEvent
  | CodexCompactedEvent;

// =============================================================================
// Response items
// =============================================================================

export interface CodexTextContentPart {
  type: 'output_text' | 'input_text' | 'text';
  text: string;
}

export interface CodexRefusalContentPart {
  type: 'refusal';
  refusal: string;
}

export type CodexContentPart = CodexTextContentPart | CodexRefusalContentPart;

export interface CodexMessageItem {
  type: 'message';
  role: 'user' | 'assistant' | 'developer';
  content: CodexContentPart[];
  phase?: string;
  [key: string]: unknown;
}

export interface CodexFunctionCallItem {
  type: 'function_call';
  name: string;
  arguments: string;
  call_id: string;
  [key: string]: unknown;
}

export interface CodexFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  /**
   * Output is usually a string, but Codex also emits it as an array of
   * text content parts (`{ type: 'input_text', text }`), e.g. for exec output.
   */
  output: string | CodexContentPart[];
  [key: string]: unknown;
}

export interface CodexReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: { type: string; text: string }[];
  [key: string]: unknown;
}

export interface CodexCustomToolCallItem {
  type: 'custom_tool_call';
  id?: string;
  status?: string;
  name?: string;
  call_id?: string;
  /** Freeform tool input (Codex "exec" harness sends the JS snippet as a string). */
  input?: string;
  [key: string]: unknown;
}

export interface CodexCustomToolCallOutputItem {
  type: 'custom_tool_call_output';
  call_id?: string;
  /** Output is a string or an array of text content parts (like function_call_output). */
  output?: string | CodexContentPart[];
  [key: string]: unknown;
}

export interface CodexWebSearchCallItem {
  type: 'web_search_call';
  id?: string;
  [key: string]: unknown;
}

export type CodexResponseItem =
  | CodexMessageItem
  | CodexFunctionCallItem
  | CodexFunctionCallOutputItem
  | CodexReasoningItem
  | CodexCustomToolCallItem
  | CodexCustomToolCallOutputItem
  | CodexWebSearchCallItem;

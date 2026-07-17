/**
 * Types for Kimi Code's wire.jsonl event stream.
 *
 * Kimi Code stores session activity as a stream of events in:
 *   ~/.kimi-code/sessions/wd_<workdir>_<hash>/<sessionId>/agents/main/wire.jsonl
 *
 * These events must be aggregated into ParsedMessage objects before the UI can
 * render them. This file describes the raw event shapes.
 */

// =============================================================================
// Common event envelope
// =============================================================================

export interface KimiWireEvent {
  type: string;
  time?: number;
  [key: string]: unknown;
}

// =============================================================================
// Top-level events
// =============================================================================

export interface KimiMetadataEvent extends KimiWireEvent {
  type: 'metadata';
  protocol_version: string;
  created_at: number;
}

export interface KimiConfigUpdateEvent extends KimiWireEvent {
  type: 'config.update';
  profileName?: string;
  systemPrompt?: string;
  modelAlias?: string;
  thinkingLevel?: string;
  thinkingEffort?: string;
  time?: number;
}

export interface KimiToolsSetActiveEvent extends KimiWireEvent {
  type: 'tools.set_active_tools';
  names: string[];
  time?: number;
}

export interface KimiToolsUpdateStoreEvent extends KimiWireEvent {
  type: 'tools.update_store';
  key: string;
  value: unknown;
  time?: number;
}

export interface KimiPermissionSetModeEvent extends KimiWireEvent {
  type: 'permission.set_mode';
  mode: string;
  time?: number;
}

export interface KimiPermissionRecordApprovalResultEvent extends KimiWireEvent {
  type: 'permission.record_approval_result';
  turnId?: number;
  toolCallId?: string;
  toolName?: string;
  action?: string;
  result?: {
    decision: string;
    selectedLabel?: string;
  };
  time?: number;
}

export interface KimiTurnPromptEvent extends KimiWireEvent {
  type: 'turn.prompt';
  input: KimiContentPart[];
  origin?: {
    kind: string;
    [key: string]: unknown;
  };
  time?: number;
}

export interface KimiTurnSteerEvent extends KimiWireEvent {
  type: 'turn.steer';
  input: KimiContentPart[];
  origin?: {
    kind: string;
    [key: string]: unknown;
  };
  time?: number;
}

export interface KimiTurnCancelEvent extends KimiWireEvent {
  type: 'turn.cancel';
  time?: number;
}

export interface KimiContextAppendMessageEvent extends KimiWireEvent {
  type: 'context.append_message';
  message: KimiMessage;
  time?: number;
}

export interface KimiContextAppendLoopEvent extends KimiWireEvent {
  type: 'context.append_loop_event';
  event: KimiLoopEvent;
  time?: number;
}

export interface KimiContextApplyCompactionEvent extends KimiWireEvent {
  type: 'context.apply_compaction';
  summary?: string;
  contextSummary?: string;
  time?: number;
}

export interface KimiFullCompactionBeginEvent extends KimiWireEvent {
  type: 'full_compaction.begin';
  source?: string;
  time?: number;
}

export interface KimiFullCompactionCompleteEvent extends KimiWireEvent {
  type: 'full_compaction.complete';
  time?: number;
}

export interface KimiLlmRequestEvent extends KimiWireEvent {
  type: 'llm.request';
  kind?: string;
  provider?: string;
  model?: string;
  modelAlias?: string;
  thinkingEffort?: string;
  thinkingKeep?: string;
  maxTokens?: number;
  toolSelect?: boolean;
  systemPromptHash?: string;
  toolsHash?: string;
  messageCount?: number;
  turnStep?: string;
  time?: number;
}

export interface KimiLlmToolsSnapshotEvent extends KimiWireEvent {
  type: 'llm.tools_snapshot';
  hash?: string;
  tools?: KimiToolSchema[];
  time?: number;
}

export interface KimiUsageRecordEvent extends KimiWireEvent {
  type: 'usage.record';
  model?: string;
  usage: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
    [key: string]: unknown;
  };
  usageScope?: string;
  time?: number;
}

export interface KimiGoalCreateEvent extends KimiWireEvent {
  type: 'goal.create';
  goalId?: string;
  objective?: string;
  completionCriterion?: string;
  time?: number;
}

export interface KimiGoalUpdateEvent extends KimiWireEvent {
  type: 'goal.update';
  turnsUsed?: number;
  time?: number;
}

export interface KimiGoalClearEvent extends KimiWireEvent {
  type: 'goal.clear';
  time?: number;
}

export interface KimiPlanModeEnterEvent extends KimiWireEvent {
  type: 'plan_mode.enter';
  id?: string;
  time?: number;
}

export interface KimiPlanModeExitEvent extends KimiWireEvent {
  type: 'plan_mode.exit';
  time?: number;
}

export interface KimiPlanModeCancelEvent extends KimiWireEvent {
  type: 'plan_mode.cancel';
  time?: number;
}

export interface KimiSwarmModeEnterEvent extends KimiWireEvent {
  type: 'swarm_mode.enter';
  trigger?: string;
  time?: number;
}

export interface KimiSwarmModeExitEvent extends KimiWireEvent {
  type: 'swarm_mode.exit';
  time?: number;
}

export interface KimiMcpToolsDiscoveredEvent extends KimiWireEvent {
  type: 'mcp.tools_discovered';
  serverName?: string;
  hash?: string;
  tools?: KimiToolSchema[];
  enabledNames?: string[];
  time?: number;
}

export type KimiTopLevelEvent =
  | KimiMetadataEvent
  | KimiConfigUpdateEvent
  | KimiToolsSetActiveEvent
  | KimiToolsUpdateStoreEvent
  | KimiPermissionSetModeEvent
  | KimiPermissionRecordApprovalResultEvent
  | KimiTurnPromptEvent
  | KimiTurnSteerEvent
  | KimiTurnCancelEvent
  | KimiContextAppendMessageEvent
  | KimiContextAppendLoopEvent
  | KimiContextApplyCompactionEvent
  | KimiFullCompactionBeginEvent
  | KimiFullCompactionCompleteEvent
  | KimiLlmRequestEvent
  | KimiLlmToolsSnapshotEvent
  | KimiUsageRecordEvent
  | KimiGoalCreateEvent
  | KimiGoalUpdateEvent
  | KimiGoalClearEvent
  | KimiPlanModeEnterEvent
  | KimiPlanModeExitEvent
  | KimiPlanModeCancelEvent
  | KimiSwarmModeEnterEvent
  | KimiSwarmModeExitEvent
  | KimiMcpToolsDiscoveredEvent;

// =============================================================================
// Content parts (used in messages and loop events)
// =============================================================================

export interface KimiTextContentPart {
  type: 'text';
  text: string;
}

export interface KimiThinkContentPart {
  type: 'think';
  think: string;
}

export interface KimiImageContentPart {
  type: 'image';
  source?: {
    type: 'base64';
    media_type?: string;
    data?: string;
  };
}

export interface KimiToolCallContentPart {
  type: 'tool_call';
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface KimiToolResultContentPart {
  type: 'tool_result';
  tool_use_id?: string;
  content?: string | unknown[];
  is_error?: boolean;
}

export type KimiContentPart =
  | KimiTextContentPart
  | KimiThinkContentPart
  | KimiImageContentPart
  | KimiToolCallContentPart
  | KimiToolResultContentPart;

// =============================================================================
// Messages (context.append_message)
// =============================================================================

export interface KimiMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | KimiContentPart[];
  toolCalls?: KimiToolCallContentPart[];
  origin?: {
    kind: string;
    [key: string]: unknown;
  };
}

// =============================================================================
// Loop events (context.append_loop_event.event)
// =============================================================================

export interface KimiStepBeginEvent {
  type: 'step.begin';
  uuid: string;
  turnId?: string | number;
  step?: number;
}

export interface KimiStepEndEvent {
  type: 'step.end';
  uuid: string;
  turnId?: string | number;
  step?: number;
  usage?: {
    inputOther?: number;
    output?: number;
    inputCacheRead?: number;
    inputCacheCreation?: number;
  };
  finishReason?: string;
  messageId?: string;
}

export interface KimiContentPartEvent {
  type: 'content.part';
  uuid: string;
  turnId?: string | number;
  step?: number;
  stepUuid?: string;
  part: KimiContentPart;
}

export interface KimiToolCallEvent {
  type: 'tool.call';
  uuid: string;
  turnId?: string | number;
  step?: number;
  stepUuid?: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  display?: {
    kind: string;
    [key: string]: unknown;
  };
}

export interface KimiToolResultEvent {
  type: 'tool.result';
  parentUuid: string;
  toolCallId: string;
  result: {
    output?: unknown;
    content?: unknown;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    [key: string]: unknown;
  };
  error?: string;
  is_error?: boolean;
}

export type KimiLoopEvent =
  | KimiStepBeginEvent
  | KimiStepEndEvent
  | KimiContentPartEvent
  | KimiToolCallEvent
  | KimiToolResultEvent;

// =============================================================================
// Tool schema (llm.tools_snapshot / mcp.tools_discovered)
// =============================================================================

export interface KimiToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

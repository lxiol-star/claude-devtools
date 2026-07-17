import { describe, expect, it } from 'vitest';

import { aggregateCodexEvents } from '../../../src/main/utils/codexWireParser';

import type { CodexTopLevelEvent } from '../../../src/main/types/codexWire';
import type { ContentBlock, ParsedMessage } from '../../../src/main/types';

/**
 * Regression fixture modeled on real Codex "rollout" JSONL. Modern Codex
 * sessions drive tools through custom_tool_call / custom_tool_call_output
 * (the model's JS harness calling tools.exec_command(...)) rather than the
 * older function_call events. These must map to assistant tool_use blocks and
 * user tool_result messages so the UI renders tool calls and their output.
 */
const TS = '2026-07-16T07:01:46.886Z';

function contentBlocks(msg: ParsedMessage): ContentBlock[] {
  return Array.isArray(msg.content) ? msg.content : [];
}

describe('codexWireParser / aggregateCodexEvents', () => {
  it('maps assistant messages, reasoning, and custom_tool_call tools', () => {
    const events: CodexTopLevelEvent[] = [
      {
        timestamp: TS,
        type: 'session_meta',
        payload: { session_id: 's1', cwd: '/tmp/project' },
      },
      {
        timestamp: TS,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'audit the page' }],
        },
      },
      {
        timestamp: TS,
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Let me plan the audit.' }],
        },
      },
      {
        timestamp: TS,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will start by loading the page.' }],
        },
      },
      {
        timestamp: TS,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          id: 'ctc_1',
          call_id: 'call_abc',
          name: 'exec',
          input: 'const r = await tools.exec_command({"cmd":"ls"});',
        },
      },
      {
        timestamp: TS,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_abc',
          output: [
            { type: 'input_text', text: 'Script completed\nOutput:\n' },
            { type: 'input_text', text: 'file-a.ts\nfile-b.ts' },
          ],
        },
      },
    ];

    const messages = aggregateCodexEvents(events);

    // Assistant text output is present (reasoning also produces an assistant
    // message, so select the one carrying the output text block).
    const assistant = messages.find(
      (m) => m.type === 'assistant' && contentBlocks(m).some((b) => b.type === 'text')
    );
    expect(assistant).toBeDefined();
    const textBlock = contentBlocks(assistant!).find((b) => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect(textBlock).toMatchObject({ type: 'text', text: 'I will start by loading the page.' });

    // The custom_tool_call became a tool_use block + ToolCall on the assistant.
    const toolUse = contentBlocks(assistant!).find((b) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', id: 'call_abc', name: 'exec' });
    expect(assistant!.toolCalls).toHaveLength(1);
    expect(assistant!.toolCalls[0]).toMatchObject({ id: 'call_abc', name: 'exec' });
    // Freeform (non-JSON) input is preserved under `code`.
    expect(assistant!.toolCalls[0].input.code).toContain('tools.exec_command');

    // The custom_tool_call_output became a linked tool_result user message.
    const result = messages.find((m) => m.sourceToolUseID === 'call_abc');
    expect(result).toBeDefined();
    expect(result!.type).toBe('user');
    expect(result!.toolResults).toHaveLength(1);
    // Array-shaped output is normalized to a joined string, not [object Object].
    expect(result!.toolResults[0].content).toBe('Script completed\nOutput:\n\nfile-a.ts\nfile-b.ts');

    // Reasoning maps to a thinking block, matching the pre-existing behavior.
    const thinking = messages.find(
      (m) => m.type === 'assistant' && contentBlocks(m).some((b) => b.type === 'thinking')
    );
    expect(thinking).toBeDefined();

    // Custom tool calls must NOT be emitted as hard-noise system messages.
    const systemNoise = messages.filter(
      (m) => m.type === 'system' && typeof m.content === 'string' && m.content.includes('Custom tool')
    );
    expect(systemNoise).toHaveLength(0);
  });

  it('still maps legacy function_call / function_call_output events', () => {
    const events: CodexTopLevelEvent[] = [
      {
        timestamp: TS,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Running a command.' }],
        },
      },
      {
        timestamp: TS,
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}',
          call_id: 'call_fn',
        },
      },
      {
        timestamp: TS,
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_fn',
          output: '/tmp/project',
        },
      },
    ];

    const messages = aggregateCodexEvents(events);

    const assistant = messages.find((m) => m.type === 'assistant');
    expect(assistant!.toolCalls[0]).toMatchObject({ id: 'call_fn', name: 'exec_command' });
    expect(assistant!.toolCalls[0].input).toEqual({ cmd: 'pwd' });

    const result = messages.find((m) => m.sourceToolUseID === 'call_fn');
    expect(result!.toolResults[0].content).toBe('/tmp/project');
  });

  it('creates a synthetic assistant for a tool call with no preceding message', () => {
    const events: CodexTopLevelEvent[] = [
      {
        timestamp: TS,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_solo',
          name: 'exec',
          input: '{"cmd":"ls"}',
        },
      },
    ];

    const messages = aggregateCodexEvents(events);
    const assistant = messages.find((m) => m.type === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.toolCalls[0]).toMatchObject({ id: 'call_solo', name: 'exec' });
    // JSON object input is parsed as-is.
    expect(assistant!.toolCalls[0].input).toEqual({ cmd: 'ls' });
  });
});

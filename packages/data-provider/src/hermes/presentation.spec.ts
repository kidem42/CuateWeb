import {
  hermesVisibleUserText,
  hermesExtractSteers,
  hermesNoticeDisplay,
  hermesDisplayRows,
} from './presentation';
import { hermesMessageViews, hermesGroupToolMessages } from './sessionView';
import { hermesContinuationRows } from './protocol';
const id = 'hermes.local.scope.session';
it('filters compaction but preserves real user text and literal markers', () => {
  expect(hermesVisibleUserText('[CONTEXT SUMMARY]: internal')).toBeNull();
  expect(
    hermesVisibleUserText(
      '[CONTEXT COMPACTION] internal\n--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---\nActual request',
    ),
  ).toBe('Actual request');
  expect(
    hermesVisibleUserText(
      '[PRIOR CONTEXT — for reference only; not a new message]\nActual request\n[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]\n[CONTEXT SUMMARY]: internal',
    ),
  ).toBe('Actual request');
  expect(hermesVisibleUserText('Explain [CONTEXT SUMMARY]: please')).toBe(
    'Explain [CONTEXT SUMMARY]: please',
  );
  expect(
    hermesVisibleUserText('[Your active task list was preserved across context compression] x'),
  ).toBeNull();
});
it('retains non-text attachments alongside hidden metadata', () => {
  const rows = hermesDisplayRows([
    {
      id: 1,
      role: 'user',
      content: [
        { type: 'text', text: '[CONTEXT SUMMARY]: x' },
        { type: 'image_url', image_url: { url: '/tmp/a.png' } },
      ],
    },
  ]);
  expect(rows[0].content).toEqual([{ type: 'image_url', image_url: { url: '/tmp/a.png' } }]);
});
it('restores multiple steers once and preserves incomplete frames', () => {
  const text =
    'output\n[OUT-OF-BAND USER MESSAGE]<cuate-addendum>frame</cuate-addendum>First<cuate-addendum>frame</cuate-addendum>Second[/OUT-OF-BAND USER MESSAGE]';
  expect(hermesExtractSteers(text)).toEqual({ output: 'output', messages: ['First', 'Second'] });
  expect(hermesExtractSteers('[OUT-OF-BAND USER MESSAGE]unfinished').messages).toEqual([]);
  const row = { id: 2, role: 'tool', content: text };
  const rows = hermesMessageViews(id, { data: [row, row], truncated: false });
  expect(rows.filter((row) => row.isCreatedByUser).map((row) => row.text)).toEqual([
    'First',
    'Second',
  ]);
  expect(new Set(rows.map((row) => row.messageId)).size).toBe(3);
});
it('displays service deliveries on the assistant side without changing consent or raw history', () => {
  const data = [
    {
      id: 1,
      role: 'user',
      content: '[ASYNC DELEGATION COMPLETE — deleg_a]\nStatus: completed\n--- RESULT ---\nResult',
    },
  ];
  const before = JSON.stringify(data);
  const rows = hermesMessageViews(id, { data, truncated: false });
  expect(rows[0].isCreatedByUser).toBe(false);
  expect(hermesNoticeDisplay(rows[0].text)?.tasks[0].result).toBe(data[0].content);
  expect(hermesContinuationRows(data)).toEqual([1]);
  expect(JSON.stringify(data)).toBe(before);
});
it('keeps batch task outcomes and unknown metadata available', () => {
  const text =
    '[ASYNC DELEGATION BATCH COMPLETE — deleg_a]\nNew metadata: keep\n--- ✓ TASK 1/2: One ---\nA\n--- ✗ TASK 2/2: Two ---\nB';
  const result = hermesNoticeDisplay(text);
  expect(result?.tasks.map((task) => task.status)).toEqual(['completed', 'error']);
  expect(result?.tasks[0].result).toContain('New metadata: keep');
  expect(result?.tasks[1].result).toBe('B');
  expect(hermesNoticeDisplay('Example: ' + text)).toBeNull();
  expect(hermesNoticeDisplay('[Background process failed to start]')?.tasks[0].status).toBe(
    'error',
  );
});
it('marks truncated tasks and consolidated process reports', () => {
  const batch =
    '[ASYNC DELEGATION BATCH COMPLETE — deleg_a]\n--- ✓ TASK 1/2: One ---\nA\n--- ⚠ TASK 2/2: Two  (status=completed, TRUNCATED: hit max_iterations — work may be incomplete) ---\nB';
  expect(hermesNoticeDisplay(batch)?.tasks.map((task) => task.status)).toEqual(['completed', 'error']);
  const processes =
    '[IMPORTANT: 2 background processes completed. Treat these results as one batch and give one consolidated response; preserve failures and actionable results.]\n\n[IMPORTANT: Background process p1 exited (exit code 2).\nCommand: make\nOutput:\nx]';
  const display = hermesNoticeDisplay(processes);
  expect(display?.kind).toBe('background_tool');
  expect(display?.tasks[0].status).toBe('error');
  expect(display?.tasks[0].result).toBe(processes);
});
it('shows a continuation turn as the user side marker identity', () => {
  const data = [
    {
      id: 4,
      role: 'user',
      content:
        '<cuate-continuation>\nContinue the original task using the background results already received in this session and prepare the answer. Do not repeat completed work.\n</cuate-continuation>',
    },
  ];
  const rows = hermesMessageViews(id, { data, truncated: false });
  expect(rows[0].isCreatedByUser).toBe(true);
  expect(rows[0].messageId.endsWith('.continuation')).toBe(true);
});
it('keeps notices and real user messages as reply boundaries', () => {
  const rows = hermesMessageViews(id, {
    truncated: false,
    data: [
      { id: 1, role: 'assistant', content: 'Before' },
      { id: 2, role: 'user', content: '[Background process finished, exit code 0]' },
      { id: 3, role: 'assistant', content: 'After' },
      { id: 4, role: 'user', content: 'New request' },
    ],
  });
  expect(rows).toHaveLength(4);
  expect(rows[3].parentMessageId).toBe(rows[2].messageId);
});

it('keeps live text visible when grouped with restored steps', () => {
  const rows = hermesMessageViews(id, {
    data: [{ id: 1, role: 'tool', content: 'OK', tool_name: 'terminal' }],
    truncated: false,
  });
  const view = hermesGroupToolMessages([
    ...rows,
    {
      conversationId: id,
      messageId: 'live',
      parentMessageId: rows[0].messageId,
      text: 'Streaming answer',
      sender: 'Hermes',
      isCreatedByUser: false,
    },
  ]);
  expect(view).toHaveLength(1);
  expect(view[0].messageId).toBe(rows[0].messageId);
  expect(view[0].content?.[0]).toEqual({ type: 'text', text: 'Streaming answer' });
  expect(view[0].content?.[1].type).toBe('tool_call');
});

import {
  hermesConversationId,
  parseHermesConversationId,
  hermesMessageViews,
  hermesNextSessionOffset,
} from './sessionView';

const identity = { connectionId: 'host', scope: 'endpoint1', sessionId: 'native_session' };
describe('native session identity and shared UI projection', () => {
  it('round-trips the original session and scopes identical IDs by endpoint', () => {
    expect(parseHermesConversationId(hermesConversationId(identity))).toEqual(identity);
    expect(hermesConversationId(identity)).not.toBe(
      hermesConversationId({ ...identity, scope: 'endpoint2' }),
    );
  });
  it.each([
    'new',
    'mongo-id',
    'hermes.host.scope',
    'hermes.host..session',
    'hermes.host.scope.a/b',
  ])('does not misroute %s', (id) => {
    expect(parseHermesConversationId(id)).toBeUndefined();
  });
  it('retains ordered message IDs, tools and images without mutating history', () => {
    const history = {
      truncated: false,
      data: [
        {
          id: 10,
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
          ],
        },
        {
          id: 20,
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call', function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' } },
          ],
        },
        {
          id: 30,
          role: 'tool',
          content: 'file result',
          tool_name: 'read_file',
          tool_call_id: 'call',
        },
      ],
    };
    const original = JSON.stringify(history);
    const id = hermesConversationId(identity);
    const rows = hermesMessageViews(id, history);
    expect(rows.map((r) => r.messageId)).toEqual([10, 20].map((n) => `${id}.message.${n}`));
    expect(rows[1].parentMessageId).toBe(rows[0].messageId);
    expect(rows[0].content).toHaveLength(2);
    expect(rows[1].content?.[0]).toMatchObject({ type: 'tool_call', tool_call: { id: 'call' } });
    expect(rows[1].content?.[0]).toMatchObject({
      tool_call: {
        name: 'read_file',
        args: '{"path":"/tmp/a"}',
        output: 'file result',
        progress: 1,
      },
    });
    expect(JSON.stringify(history)).toBe(original);
  });
  it('joins parallel results by exact ID even when they arrive out of order', () => {
    const rows = hermesMessageViews(hermesConversationId(identity), {
      truncated: false,
      data: [
        {
          id: 1,
          role: 'assistant',
          content: 'Checking',
          tool_calls: [
            { id: 'a', function: { name: 'terminal', arguments: 'first' } },
            { id: 'b', function: { name: 'terminal', arguments: 'second' } },
          ],
        },
        { id: 2, role: 'tool', tool_call_id: 'b', content: 'B' },
        { id: 3, role: 'tool', tool_call_id: 'a', content: '' },
        { id: 4, role: 'assistant', content: 'Done' },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].content?.slice(2)).toMatchObject([
      { tool_call: { id: 'a', output: '', progress: 1 } },
      { tool_call: { id: 'b', output: 'B', progress: 1 } },
    ]);
    expect(rows[0].text).toBe('Checking\n\nDone');
  });
  it('keeps unmatched results in stock tool cards without guessing a matching call', () => {
    const rows = hermesMessageViews(hermesConversationId(identity), {
      truncated: true,
      data: [
        {
          id: 1,
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'a', function: { name: 'terminal' } }],
        },
        {
          id: 2,
          role: 'tool',
          tool_call_id: 'other',
          tool_name: 'terminal',
          content: '{"error":"failed"}',
        },
        { id: 3, role: 'tool', tool_name: 'terminal', content: 'orphan' },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].content?.[0]).not.toHaveProperty('tool_call.output');
    expect(rows[0].text).toBe('');
    expect(rows[0].content?.[1]).toMatchObject({
      type: 'tool_call',
      tool_call: { id: 'other', output: '{"error":"failed"}', progress: 1 },
    });
    expect(rows[0].content?.[2]).toMatchObject({ tool_call: { output: 'orphan' } });
  });
  it('does not attach a result to a call from an earlier user turn', () => {
    const rows = hermesMessageViews(hermesConversationId(identity), {
      truncated: false,
      data: [
        {
          id: 1,
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'reused', function: { name: 'terminal' } }],
        },
        { id: 2, role: 'user', content: 'Next task' },
        { id: 3, role: 'tool', tool_call_id: 'reused', content: 'new result' },
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0].content?.[0]).not.toHaveProperty('tool_call.output');
    expect(rows[2].content?.[0]).toMatchObject({ tool_call: { output: 'new result' } });
  });
  it('groups successive execution steps while preserving answers, user boundaries and stable ancestry', () => {
    const data = [
      { id: 1, role: 'user', content: 'Task' },
      {
        id: 2,
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'a', function: { name: 'terminal' } }],
      },
      { id: 3, role: 'tool', content: 'A', tool_call_id: 'a' },
      {
        id: 4,
        role: 'assistant',
        content: '  ',
        tool_calls: [{ id: 'b', function: { name: 'patch' } }],
      },
      { id: 5, role: 'tool', content: 'B', tool_call_id: 'b' },
      { id: 6, role: 'assistant', content: 'Final answer' },
      { id: 7, role: 'user', content: 'Next task' },
      {
        id: 8,
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c', function: { name: 'terminal' } }],
      },
    ];
    const original = JSON.stringify(data);
    const id = hermesConversationId(identity);
    const rows = hermesMessageViews(id, { data, truncated: false });
    expect(rows.map((row) => row.messageId)).toEqual([1, 2, 7, 8].map((n) => `${id}.message.${n}`));
    expect(rows[1].content?.slice(1)).toMatchObject([
      { type: 'tool_call', tool_call: { id: 'a', output: 'A' } },
      { type: 'tool_call', tool_call: { id: 'b', output: 'B' } },
    ]);
    expect(rows[1].text).toBe('Final answer');
    expect(rows[2].parentMessageId).toBe(rows[1].messageId);
    const partial = hermesMessageViews(id, { data: data.slice(0, 4), truncated: false });
    expect(partial[1].messageId).toBe(rows[1].messageId);
    expect(JSON.stringify(data)).toBe(original);
  });
  it('does not move commentary or images inside collapsed execution steps', () => {
    const rows = hermesMessageViews(hermesConversationId(identity), {
      truncated: false,
      data: [
        { id: 1, role: 'tool', content: 'A', tool_name: 'terminal' },
        { id: 2, role: 'assistant', content: 'Explanation' },
        { id: 3, role: 'tool', content: 'B', tool_name: 'patch' },
        {
          id: 4,
          role: 'assistant',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('Explanation');
    expect(rows[0].content?.map((part) => part.type)).toEqual([
      'text',
      'image_file',
      'tool_call',
      'tool_call',
    ]);
  });
  it('deduplicates repeated page rows without breaking ancestry', () => {
    const row = { id: 1, role: 'user', content: 'text' };
    expect(
      hermesMessageViews(hermesConversationId(identity), { data: [row, row], truncated: false }),
    ).toHaveLength(1);
  });
});
describe('Gateway pagination', () => {
  it('advances by the reported window, not by extra pinned rows', () => {
    expect(
      hermesNextSessionOffset({
        data: Array.from({ length: 11 }, (_, n) => ({ id: String(n), pinned: n > 0 })),
        offset: 0,
        limit: 1,
        has_more: true,
      }),
    ).toBe(1);
  });
  it('honors has_more false even with backfilled pins', () => {
    expect(
      hermesNextSessionOffset({
        data: [{ id: 'pin', pinned: true }],
        offset: 50,
        limit: 50,
        has_more: false,
      }),
    ).toBeUndefined();
  });
  it('refuses a non-advancing window', () => {
    expect(() =>
      hermesNextSessionOffset({ data: [], offset: 0, limit: 0, has_more: true }),
    ).toThrow('invalid_hermes_pagination');
  });
});

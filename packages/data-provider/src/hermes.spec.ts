import * as protocol from './hermes/protocol';
import type { HermesFrame } from './hermes';
import {
  createHermesDecoder,
  hermesAttachmentNote,
  hermesConfigSchema,
  hermesOccupancy,
  hermesRequestSchema,
  hermesUnframe,
} from './hermes';

describe('Hermes wire compatibility', () => {
  it('uses native occupancy before legacy patch values and never substitutes throughput', () => {
    expect(hermesOccupancy({ total_tokens: 2_188_000, input_tokens: 2_000_000 })).toBeUndefined();
    expect(hermesOccupancy({ context_tokens: 19859, context_window: 1050000 })?.used).toBe(19859);
    expect(
      hermesOccupancy({
        context_used: 35000,
        context_max: 272000,
        context_estimated: true,
        context_source: 'provider_usage_plus_estimate',
        context_tokens: 900000,
        context_window: 1000000,
      }),
    ).toMatchObject({ used: 35000, max: 272000, estimated: true });
    expect(hermesOccupancy({ context_used: 0, context_max: 272000 })?.percent).toBe(0);
    expect(hermesOccupancy({ context_used: -1, context_max: 100 })).toBeUndefined();
    expect(hermesOccupancy({ context_tokens: 200, context_window: 100 })?.percent).toBe(100);
  });
  it('decodes SSE split at every character, including CRLF and multiline JSON', () => {
    const frames: HermesFrame[] = [];
    const decode = createHermesDecoder((frame) => frames.push(frame));
    const input =
      ': heartbeat\r\nevent: assistant.delta\r\ndata: {\r\ndata: "delta":"Привет"}\r\n\r\nevent: run.completed\ndata: {"usage":{"context_used":12,"context_max":100}}\n\n';
    for (const character of input) {
      decode(character);
    }
    expect(frames).toHaveLength(2);
    expect(frames[0].data.delta).toBe('Привет');
    expect(hermesOccupancy(frames[1].data.usage)?.used).toBe(12);
  });
  it('preserves the Cuate attachment and steer wire conventions', () => {
    expect(hermesAttachmentNote(['/root/a.pdf'])).toBe(
      'Attached file (read it from your host):\n- /root/a.pdf',
    );
    expect(hermesAttachmentNote(['/root/a', '/root/b'])).toBe(
      'Attached files (read them from your host):\n- /root/a\n- /root/b',
    );
    expect(hermesUnframe('<cuate-addendum>instructions</cuate-addendum>\n\nhello')).toBe('hello');
  });
  it('rejects traversal and arbitrary proxy operations', () => {
    expect(
      hermesRequestSchema.safeParse({ operation: 'messages', sessionId: '../admin' }).success,
    ).toBe(false);
    expect(
      hermesRequestSchema.safeParse({ operation: 'fetch', url: 'https://attacker.test' }).success,
    ).toBe(false);
  });
  it('is disabled by default and refuses credential-bearing URLs', () => {
    expect(hermesConfigSchema.parse({}).connections).toEqual([]);
    expect(
      hermesConfigSchema.safeParse({
        connections: [
          {
            id: 'main',
            label: 'Main',
            apiURL: 'http://user:secret@localhost',
            apiKeyEnv: 'KEY',
            userIds: ['owner'],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('Hermes native transcript semantics', () => {
  it('offers only the current delivery suffix and ignores already consumed IDs', () => {
    const notice = { id: 8, role: 'user', content: '[ASYNC DELEGATION COMPLETE deleg_a]\nDone' };
    expect(protocol.hermesContinuationRows([notice])).toEqual([8]);
    expect(
      protocol.hermesContinuationRows([notice, { id: 9, role: 'assistant', content: 'Answer' }]),
    ).toEqual([]);
    expect(protocol.hermesNeedsContinuation([8], [8])).toBe(false);
    expect(protocol.hermesSameDelivery([8], [8, 9])).toBe(false);
  });
  it('does not mistake a background delivery for an active parent run', () => {
    expect(
      protocol.hermesLiveTail(
        [{ id: 8, role: 'user', content: '[IMPORTANT: Background process completed]' }],
        Date.now(),
        1200000,
      ),
    ).toBe(false);
    expect(
      protocol.hermesLiveTail(
        [{ id: 9, role: 'tool', content: 'result', timestamp: 1 }],
        2000000,
        1200000,
      ),
    ).toBe(false);
    expect(
      protocol.hermesLiveTail([{ id: 9, role: 'tool', content: 'result' }], 2000000, 1200000),
    ).toBe(true);
  });
  it('keeps independent delegated units pending until their own deliveries arrive', () => {
    const dispatch = {
      id: 1,
      role: 'tool',
      tool_name: 'delegate_task',
      content: JSON.stringify({
        status: 'dispatched',
        mode: 'background',
        delegation_id: 'deleg_parent',
        count: 3,
        units: [
          { delegation_id: 'deleg_a', task_indexes: [0] },
          { delegation_id: 'deleg_b', task_indexes: [1, 2] },
        ],
      }),
    };
    expect(
      protocol.hermesBackgroundWork([
        dispatch,
        { id: 2, role: 'user', content: '[ASYNC DELEGATION COMPLETE deleg_a]' },
      ]),
    ).toEqual([{ id: 'deleg_b', count: 2, timestamp: undefined }]);
  });
  it('finishes units from consolidated deliveries but not from early task failures', () => {
    const dispatch = {
      id: 1,
      role: 'tool',
      tool_name: 'delegate_task',
      content: JSON.stringify({
        status: 'dispatched',
        mode: 'background',
        delegation_id: 'deleg_parent',
        count: 2,
        units: [
          { delegation_id: 'deleg_a', task_indexes: [0] },
          { delegation_id: 'deleg_b', task_indexes: [1] },
        ],
      }),
    };
    const early = {
      id: 2,
      role: 'user',
      content: '[ASYNC DELEGATION TASK FAILED — deleg_b, task 2/2]\nTask: x\nStatus: failed',
    };
    expect(protocol.hermesServiceNotice(early.content)).toBe(true);
    expect(protocol.hermesBackgroundWork([dispatch, early]).map((item) => item.id)).toEqual([
      'deleg_a',
      'deleg_b',
    ]);
    const consolidated = {
      id: 3,
      role: 'user',
      content:
        '[IMPORTANT: 2 background subagent delegations completed for this session. Treat these results as one completion batch and send at most one consolidated user-facing response. If a result does not change the current conclusion, absorb it silently.]\n\n' +
        '[ASYNC DELEGATION COMPLETE — deleg_a]\nDone\n\n[ASYNC DELEGATION BATCH COMPLETE — deleg_b]\nDone',
    };
    expect(protocol.hermesServiceNotice(consolidated.content)).toBe(true);
    expect(protocol.hermesBackgroundWork([dispatch, consolidated])).toEqual([]);
    expect(protocol.hermesContinuationRows([consolidated])).toEqual([3]);
  });
  it('frames the continuation turn and recognizes the prompts of older clients', () => {
    expect(protocol.hermesContinuationPrompt.startsWith('<cuate-continuation>\n')).toBe(true);
    expect(protocol.hermesIsContinuation(protocol.hermesContinuationPrompt)).toBe(true);
    expect(
      protocol.hermesIsContinuation(
        '  Продолжи исходную задачу с учётом фоновых результатов, уже полученных в этой сессии, и подготовь ответ. Не повторяй завершённую работу.\n',
      ),
    ).toBe(true);
    expect(protocol.hermesIsContinuation('Continue the original task, please')).toBe(false);
    expect(protocol.hermesServiceNotice(protocol.hermesContinuationPrompt)).toBe(false);
    expect(protocol.hermesServiceNotice('[IMPORTANT: remember the milk]')).toBe(false);
  });
  it('extracts real attachment notes and host result paths without treating prose as attachments', () => {
    expect(
      protocol.hermesSplitAttachments(
        'Look\n\nAttached file (read it from your host):\n- /tmp/a file.pdf\n[attachment]',
      ),
    ).toEqual({ text: 'Look', paths: ['/tmp/a file.pdf'] });
    expect(protocol.hermesSplitAttachments('A list:\n- /tmp/a')).toEqual({
      text: 'A list:\n- /tmp/a',
      paths: [],
    });
    expect(
      protocol.hermesMessagePaths({
        id: 1,
        role: 'assistant',
        content: '[report](sandbox:/tmp/my%20report.pdf)',
        tool_calls: [{ function: { arguments: '{"path":"/tmp/a.txt"}' } }],
      }),
    ).toEqual(['/tmp/a.txt', '/tmp/my report.pdf']);
  });
});

describe('Hermes title limits', () => {
  it('rejects titles beyond the native 100-character contract before forwarding', () => {
    for (const operation of ['create', 'rename']) {
      const base = { operation, sessionId: 's', title: 'a'.repeat(100) };
      expect(hermesRequestSchema.safeParse(base).success).toBe(true);
      expect(hermesRequestSchema.safeParse({ ...base, title: 'a'.repeat(101) }).success).toBe(
        false,
      );
      expect(hermesRequestSchema.safeParse({ ...base, title: '😀'.repeat(100) }).success).toBe(
        true,
      );
    }
  });
});

it('accepts native null optional tool/runtime/usage fields without losing subsequent completion', () => {
  const frames: HermesFrame[] = [];
  const decode = createHermesDecoder((frame) => frames.push(frame));
  decode(
    'event: tool.completed\ndata: {"run_id":"r","tool_name":"write_file","args":null,"preview":null}\n\nevent: assistant.completed\ndata: {"content":"Done","runtime":{"provider":null,"model":"example"}}\n\nevent: run.completed\ndata: {"usage":{"context_used":null,"context_max":null,"input_tokens":4}}\n\n',
    true,
  );
  expect(frames.map((frame) => frame.event)).toEqual([
    'tool.completed',
    'assistant.completed',
    'run.completed',
  ]);
  expect(frames[0].data.args).toBeUndefined();
  expect(frames[2].data.usage?.input_tokens).toBe(4);
});

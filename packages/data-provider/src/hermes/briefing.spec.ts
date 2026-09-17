import { hermesWithBriefing, hermesStripBriefing, hermesHasBriefing } from './briefing';
import { hermesMessageViews } from './sessionView';

describe('Cuate formatting protocol', () => {
  it('preserves native slash commands and does not nest a briefing', () => {
    expect(hermesWithBriefing('  /help')).toBe('  /help');
    const text = hermesWithBriefing('Hello');
    expect(hermesWithBriefing(text)).toBe(text);
    expect(hermesStripBriefing(text)).toBe('Hello');
  });
  it('recognizes another Cuate client without matching prose or broken tags', () => {
    expect(hermesStripBriefing('  <cuate-briefing>Desktop rules</cuate-briefing>\nHi')).toBe('Hi');
    for (const text of ['<cuate-briefing>broken', 'Quote <cuate-briefing>x</cuate-briefing>'])
      expect(hermesStripBriefing(text)).toBe(text);
  });
  it('strips user display text and retains images, IDs and the original history', () => {
    const history = {
      data: [
        {
          id: 1,
          role: 'user',
          content: [
            { type: 'text', text: hermesWithBriefing('See image') },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
          ],
        },
      ],
      truncated: false,
    };
    expect(hermesHasBriefing(history)).toBe(true);
    const rows = hermesMessageViews('hermes.c.scope.s', history);
    expect(rows[0].text).toBe('See image');
    expect(rows[0].content?.[0]).toEqual({ type: 'text', text: 'See image' });
    expect(rows[0].content?.[1].type).toBe('image_file');
    expect(hermesHasBriefing(history)).toBe(true);
    history.data[0].content.reverse();
    expect(hermesMessageViews('hermes.c.scope.s', history)[0].content?.[1]).toEqual({
      type: 'text',
      text: 'See image',
    });
  });
  it('never strips an assistant quotation of the protocol', () => {
    const text = hermesWithBriefing('example');
    const history = { data: [{ id: 1, role: 'assistant', content: text }], truncated: false };
    expect(hermesHasBriefing(history)).toBe(false);
    expect(hermesMessageViews('hermes.c.scope.s', history)[0].text).toBe(text);
  });
});

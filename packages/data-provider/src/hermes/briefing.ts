import type { HermesHistory } from '../hermes';

const opening = '<cuate-briefing>';
const closing = '</cuate-briefing>';

/** Shared Cuate wire markers; only a complete leading frame is presentation metadata. */
export function hermesStripBriefing(text: string): string {
  const start = text.trimStart();
  if (!start.startsWith(opening)) return text;
  const end = start.indexOf(closing, opening.length);
  return end < 0 ? text : start.slice(end + closing.length).trimStart();
}
export function hermesHasBriefing(history: HermesHistory): boolean {
  return history.data.some((row) => {
    if (row.role !== 'user') return false;
    const text =
      typeof row.content === 'string'
        ? row.content
        : (row.content?.find((part) => part.type === 'text')?.text ?? '');
    return hermesStripBriefing(text) !== text;
  });
}

/** A first ordinary turn carries the display contract; slash commands remain native commands. */
export function hermesWithBriefing(message: string): string {
  if (message.trimStart().startsWith('/') || hermesStripBriefing(message) !== message)
    return message;
  return [
    opening,
    'This session is being viewed in CuateWeb, which renders Markdown.',
    'Format ordinary replies with useful headings, short paragraphs, lists, emphasis, links, quotes and tables. Use inline code for commands, paths, identifiers and other copyable values. Keep ordinary replies directly in Markdown, outside document cards.',
    'For a complete interactive document, output one self-contained html fenced code block. For diagrams, use a mermaid fence. For a downloadable README, report, article or specification, put the entire document in a markdown fence beginning with # Title.',
    'When revising an HTML or Markdown document, output the complete replacement, not a fragment or diff.',
    'If the session moves to another channel, adapt formatting to that channel.',
    closing,
    '',
    message,
  ].join('\n');
}

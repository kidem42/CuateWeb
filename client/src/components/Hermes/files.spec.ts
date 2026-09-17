import { sessionFiles, fileParent } from './files';

it('collects handed-over files newest first, separately from user attachments', () => {
  expect(
    sessionFiles([
      {
        id: 1,
        role: 'assistant',
        content: 'Saved `/tmp/old.md` and [Report](sandbox:/tmp/My%20Report.pdf)',
      },
      {
        id: 2,
        role: 'user',
        content: 'Attached file (read it from your host):\n- /root/cu ate/photo.png',
      },
      { id: 3, role: 'assistant', content: 'Updated `/tmp/old.md`' },
    ]),
  ).toEqual([
    { path: '/tmp/old.md', source: 'assistant' },
    { path: '/root/cu ate/photo.png', source: 'user' },
    { path: '/tmp/My Report.pdf', source: 'assistant' },
  ]);
});
it('excludes tools, service reports, external URLs and unrooted references', () => {
  expect(
    sessionFiles([
      { id: 1, role: 'tool', content: '/tmp/internal.json' },
      { id: 2, role: 'user', content: '[ASYNC DELEGATION COMPLETE]\n/tmp/private.md' },
      { id: 3, role: 'assistant', content: '[Web](https://example.com/a.pdf) `relative.md`' },
      {
        id: 4,
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', function: { name: 'read_file', arguments: '{"path":"/etc/config.json"}' } },
        ],
      },
    ]),
  ).toEqual([]);
});
it('does not mix session histories or mutate source rows', () => {
  const rows = [{ id: 1, role: 'assistant', content: '`~/report.md`' }];
  const before = JSON.stringify(rows);
  expect(sessionFiles(rows)).toHaveLength(1);
  expect(sessionFiles([])).toEqual([]);
  expect(JSON.stringify(rows)).toBe(before);
  expect(fileParent('~/report.md')).toBe('~');
  expect(fileParent('/report.md')).toBe('/');
});

it.each(['jpg', 'png', 'docx', 'xlsx', 'zip', 'unknown'])(
  'collects MEDIA %s deliveries for both reply chips and the folder',
  (extension) => {
    const path = `/root/hermes/work/result.${extension}`;
    expect(sessionFiles([{ id: 1, role: 'assistant', content: `Done\nMEDIA:${path}` }])).toEqual([
      { path, source: 'assistant' },
    ]);
  },
);
it('supports quoted media paths, extensionless files and deduplicates ordinary references', () => {
  expect(
    sessionFiles([
      {
        id: 1,
        role: 'assistant',
        content: 'MEDIA:"/tmp/My report.docx"\nMEDIA:/tmp/download\nSaved `/tmp/My report.docx`',
      },
    ]),
  ).toEqual([
    { path: '/tmp/My report.docx', source: 'assistant' },
    { path: '/tmp/download', source: 'assistant' },
  ]);
});
it('does not turn external or relative MEDIA references into host file access', () => {
  expect(
    sessionFiles([
      {
        id: 1,
        role: 'assistant',
        content:
          'MEDIA:https://example.com/photo.jpg\nMEDIA:relative.jpg\nMEDIA://example.com/photo.jpg',
      },
    ]),
  ).toEqual([]);
});

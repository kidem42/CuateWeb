import { createAcknowledgedSender } from '../acknowledgedSend';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
describe('acknowledged composer sends', () => {
  it('claims synchronously and clears only after acknowledgement', async () => {
    let acknowledge!: () => void;
    const send = jest.fn(
      () =>
        new Promise<void>((r) => {
          acknowledge = r;
        }),
    );
    const consume = jest.fn();
    const sender = createAcknowledgedSender();
    const options = { send, consume, stillCurrent: () => true };
    expect(sender.submit('text', options)).toBe(false);
    sender.submit('text', options);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    acknowledge();
    await flush();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(sender.pending).toBe(false);
  });
  it('retains the draft and never repeats a lost response', async () => {
    const send = jest.fn().mockRejectedValue(new Error('lost response'));
    const consume = jest.fn();
    const sender = createAcknowledgedSender();
    sender.submit('text', { send, consume, stillCurrent: () => true });
    await flush();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
    expect(sender.pending).toBe(false);
  });
  it('does not erase a newer draft or a different chat', async () => {
    const consume = jest.fn();
    createAcknowledgedSender().submit('old', {
      send: async () => {},
      consume,
      stillCurrent: () => false,
    });
    await flush();
    expect(consume).not.toHaveBeenCalled();
  });
  it('does not send blank text', async () => {
    const send = jest.fn();
    createAcknowledgedSender().submit(' ', { send, consume: jest.fn(), stillCurrent: () => true });
    await flush();
    expect(send).not.toHaveBeenCalled();
  });
});

it('sends an attachment-only submission once after explicit attachment validation', async () => {
  const send = jest.fn().mockResolvedValue(undefined);
  const consume = jest.fn();
  const sender = createAcknowledgedSender();
  const options = { send, consume, stillCurrent: () => true, hasAttachments: true };
  sender.submit('', options);
  sender.submit('', options);
  await flush();
  expect(send).toHaveBeenCalledTimes(1);
  expect(consume).toHaveBeenCalledTimes(1);
});

it('consumes acknowledgement before a new session navigation and only once', async () => {
  let current = true;
  const consume = jest.fn();
  createAcknowledgedSender().submit('new chat', {
    send: async (_text, accepted) => {
      accepted();
      current = false;
    },
    stillCurrent: () => current,
    consume,
  });
  await flush();
  expect(consume).toHaveBeenCalledTimes(1);
});

it('does not consume a newer draft when acknowledgement arrives before stream completion', async () => {
  let draft = 'sent';
  const consume = jest.fn();
  createAcknowledgedSender().submit('sent', {
    send: async (_text, accepted) => {
      draft = 'next draft';
      accepted();
    },
    stillCurrent: () => draft === 'sent',
    consume,
  });
  await flush();
  expect(consume).not.toHaveBeenCalled();
});

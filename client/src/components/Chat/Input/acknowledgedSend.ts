/** Keep the draft until the remote backend acknowledges this exact submission. */
export function createAcknowledgedSender() {
  let pending = false;
  return {
    submit(
      text: string,
      options: {
        send: (text: string, accepted: () => void) => Promise<void>;
        stillCurrent: () => boolean;
        consume: () => void;
        settled?: () => void;
        hasAttachments?: boolean;
      },
    ): false {
      if (pending || (!text.trim() && !options.hasAttachments)) return false;
      pending = true;
      let acknowledged = false;
      const accept = () => {
        if (acknowledged) return;
        acknowledged = true;
        if (options.stillCurrent()) options.consume();
      };
      // Claim before calling the transport, including synchronous failures.
      void Promise.resolve()
        .then(() => options.send(text, accept))
        .then(accept)
        .catch(() => {
          // The controller owns error presentation. An unknown outcome never retries.
        })
        .finally(() => {
          pending = false;
          options.settled?.();
        });
      return false;
    },
    get pending() {
      return pending;
    },
  };
}

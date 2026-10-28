declare module "imapflow" {
  export class ImapFlow {
    constructor(options: any);
    /** False once the connection is closed; imapflow does not reconnect. */
    usable: boolean;
    on(event: "error" | "close", listener: (...args: any[]) => void): this;
    connect(): Promise<void>;
    getMailboxLock(mailbox: string): Promise<{ release(): void }>;
    /**
     * `range` is read as UIDs only when `options.uid` is true. `query.uid`
     * just asks for the UID attribute.
     */
    fetch(range: string, query: any, options?: { uid?: boolean }): AsyncIterable<any>;
    logout(): Promise<void>;
  }
}

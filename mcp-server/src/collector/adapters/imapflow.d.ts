declare module "imapflow" {
  export class ImapFlow {
    constructor(options: any);
    /** False once the connection is closed; imapflow does not reconnect. */
    usable: boolean;
    /** The selected mailbox, while a mailbox lock is held. */
    mailbox: { uidValidity?: bigint | number | string } | false;
    on(event: "error" | "close", listener: (...args: any[]) => void): this;
    connect(): Promise<void>;
    getMailboxLock(mailbox: string): Promise<{ release(): void }>;
    /**
     * `range` is read as UIDs only when `options.uid` is true. `query.uid`
     * just asks for the UID attribute.
     */
    fetch(range: string, query: any, options?: { uid?: boolean }): AsyncIterable<any>;
    /** With `options.uid`, a UID SEARCH returning UIDs. */
    search(query: any, options?: { uid?: boolean }): Promise<number[] | false | undefined>;
    logout(): Promise<void>;
  }
}

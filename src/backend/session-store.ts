/**
 * In-memory session registry owned by the Electron main process.
 * A session is keyed by the id of the WebContents that authenticated, so a
 * login in one window never authorizes another one. Kept free of Electron and
 * DB imports so it can be unit tested in plain Node.
 */
export interface SenderLike {
  id: number;
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "did-navigate", listener: (e: unknown, url: string) => void): unknown;
}

export class SessionStore {
  private sessions = new Map<number, number>();
  private hooked = new Set<number>();

  /**
   * Binds `userId` to the sender. The session is released when the window is
   * destroyed or when its main frame navigates to a URL that is not trusted.
   */
  start(sender: SenderLike, userId: number, isTrustedUrl: (url: string) => boolean): void {
    const key = sender.id;
    this.sessions.set(key, userId);
    if (this.hooked.has(key)) return; // hooks are registered once per window
    this.hooked.add(key);
    sender.once("destroyed", () => {
      this.sessions.delete(key);
      this.hooked.delete(key);
    });
    sender.on("did-navigate", (_e, url) => {
      if (!isTrustedUrl(url)) this.sessions.delete(key);
    });
  }

  get(key: number): number | undefined {
    return this.sessions.get(key);
  }

  end(key: number): void {
    this.sessions.delete(key);
  }

  get size(): number {
    return this.sessions.size;
  }
}

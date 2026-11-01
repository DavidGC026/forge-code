interface Subscription<T> {
  active: boolean;
  callback: (value: T) => void;
}

/** Retains the latest startup value until a live subscriber can receive it. */
export class BufferedStartupEvent<T> {
  private pending: { value: T } | undefined;
  private scheduled = false;
  private readonly subscriptions = new Set<Subscription<T>>();

  constructor(private readonly onError: (error: unknown) => void) {}

  publish(value: T): void {
    this.pending = { value };
    this.schedule();
  }

  subscribe(callback: (value: T) => void): { dispose: () => void } {
    const subscription = { active: true, callback };
    this.subscriptions.add(subscription);
    this.schedule();
    return {
      dispose: () => {
        subscription.active = false;
        this.subscriptions.delete(subscription);
      },
    };
  }

  private schedule(): void {
    if (this.scheduled || !this.pending || this.subscriptions.size === 0) return;
    this.scheduled = true;
    // React StrictMode can dispose and recreate an effect in the same turn.
    // Deliver after that cycle so the discarded subscription cannot consume
    // the one startup event or open the workspace twice.
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.pending || this.subscriptions.size === 0) return;
      const { value } = this.pending;
      this.pending = undefined;
      for (const subscription of [...this.subscriptions]) {
        if (!subscription.active) continue;
        try { subscription.callback(value); }
        catch (error) { this.onError(error); }
      }
    });
  }
}

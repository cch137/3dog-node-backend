export class ProtectedTinyNotifier<T = unknown> {
  constructor() {}

  private readonly callbacks = new Array<(message: T) => void>();

  subscribe(cb: (message: T) => void) {
    if (!this.callbacks.includes(cb)) this.callbacks.push(cb);
    return () => this.unsubscribe(cb);
  }

  unsubscribe(cb: (message: T) => void) {
    const index = this.callbacks.indexOf(cb);
    if (index === -1) return false;
    this.callbacks.splice(index, 1);
    return true;
  }

  protected notify(message: T) {
    const errors: unknown[] = [];
    const snapshot = this.callbacks.slice();
    for (const cb of snapshot) {
      try {
        cb(message);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(
        errors,
        `${ProtectedTinyNotifier.name}.${this.notify.name}() failed`
      );
    }
  }
}

export class TinyNotifier<T = unknown> extends ProtectedTinyNotifier<T> {
  notify(message: T) {
    return super.notify(message);
  }
}

// Coordinator Durable Object: one global instance ("global") owns all coordination state in its
// SQLite storage. Requests are processed one at a time, and every mutation runs in transactionSync,
// which gives atomic, race-free reservations without a separate lock service.
import { createDurableObjectStore } from './store/store.js';
import { createApp } from './app.js';

export class Coordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.app = null;
    state.blockConcurrencyWhile(async () => {
      this.app = createApp({ store: createDurableObjectStore(state.storage), env });
      await this.app.ensureSeeded();
    });
  }

  async fetch(request) {
    return this.app.handle(request);
  }
}

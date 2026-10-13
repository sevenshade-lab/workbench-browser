import { EventEmitter } from 'node:events';
import { say } from './lang.mjs';

const disconnected = () => new Error(say('浏览器连接已断开', 'The connection to the browser was lost'));

// Chrome's debug channel over a pipe: one JSON message at a time, each terminated by \0.
// A pipe rather than a port, because Chrome exits by itself when the pipe breaks, so killing the plugin
// never leaves an orphan browser behind.
export class CdpPipe extends EventEmitter {
  #out;
  #nextId = 1;
  #pending = new Map();
  #parts = [];
  #closed = false;

  constructor(toBrowser, fromBrowser) {
    super();
    this.#out = toBrowser;
    fromBrowser.on('data', (chunk) => this.#onData(chunk));
    fromBrowser.on('close', () => this.#fail());
    fromBrowser.on('error', () => this.#fail());
    toBrowser.on('error', () => this.#fail());
  }

  get closed() {
    return this.#closed;
  }

  send(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(disconnected());
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.#out.write(JSON.stringify(message) + '\0');
    });
  }

  #onData(chunk) {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0, start);
      if (end === -1) {
        if (start < chunk.length) this.#parts.push(start ? chunk.subarray(start) : chunk);
        return;
      }
      const piece = chunk.subarray(start, end);
      const raw = this.#parts.length ? Buffer.concat([...this.#parts, piece]) : piece;
      this.#parts = [];
      start = end + 1;
      this.#dispatch(raw);
    }
  }

  #dispatch(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiting = this.#pending.get(message.id);
      if (!waiting) return;
      this.#pending.delete(message.id);
      if (message.error) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
    } else if (message.method) {
      this.emit('event', message);
    }
  }

  #fail() {
    if (this.#closed) return;
    this.#closed = true;
    const error = disconnected();
    for (const waiting of this.#pending.values()) waiting.reject(error);
    this.#pending.clear();
    this.emit('close');
  }
}

import { EventEmitter } from 'node:events';

// Chrome 的管道调试通道：一条消息一个 JSON，以 \0 结尾。
// 用管道而不是端口，是因为管道一断 Chrome 就自己退出，插件被杀也不会留下孤儿浏览器。
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
    if (this.#closed) return Promise.reject(new Error('浏览器连接已断开'));
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
    const error = new Error('浏览器连接已断开');
    for (const waiting of this.#pending.values()) waiting.reject(error);
    this.#pending.clear();
    this.emit('close');
  }
}

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

// 面板和插件后台之间的 WebSocket（RFC 6455 服务端）。
// Antigravity 自带的运行时没有 npm，SDK 也只管普通 HTTP，所以这一小段自己写。
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

export function rejectUpgrade(socket, status = '403 Forbidden') {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    rejectUpgrade(socket, '400 Bad Request');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  socket.setTimeout(0);
  const connection = new WsConnection(socket);
  if (head && head.length) connection.feed(head);
  return connection;
}

export class WsConnection extends EventEmitter {
  #socket;
  #buffer = Buffer.alloc(0);
  #fragments = [];
  #fragmentOpcode = 0;
  #fragmentSize = 0;
  #open = true;

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('close', () => this.#closed());
    socket.on('error', () => this.#closed());
  }

  get open() {
    return this.#open;
  }

  // 还没写进系统缓冲区的字节数；画面帧靠它判断对面是不是跟不上了。
  get backlog() {
    return this.#socket.writableLength;
  }

  sendText(text) {
    this.#write(0x1, Buffer.from(text, 'utf8'));
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value));
  }

  sendBinary(buffer) {
    this.#write(0x2, buffer);
  }

  close(code = 1000) {
    if (!this.#open) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.#write(0x8, payload);
    this.#open = false;
    this.#socket.end();
    this.emit('close');
  }

  feed(chunk) {
    if (!this.#open) return;
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.#readFrame();
      if (!frame) return;
      this.#handleFrame(frame);
      if (!this.#open) return;
    }
  }

  #readFrame() {
    const buffer = this.#buffer;
    if (buffer.length < 2) return null;
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return null;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return null;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(MAX_MESSAGE)) return this.#protocolError(1009);
      length = Number(big);
      offset = 10;
    }
    // 浏览器发来的帧必须带掩码，没带就是别的东西在连。
    if (!masked) return this.#protocolError(1002);
    if (length > MAX_MESSAGE) return this.#protocolError(1009);
    if (buffer.length < offset + 4 + length) return null;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.allocUnsafe(length);
    const body = buffer.subarray(offset + 4, offset + 4 + length);
    for (let i = 0; i < length; i++) payload[i] = body[i] ^ mask[i & 3];
    this.#buffer = buffer.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }

  #handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      this.close(1000);
      return;
    }
    if (opcode === 0x9) {
      this.#write(0xA, payload);
      return;
    }
    if (opcode === 0xA) return;
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        this.#deliver(opcode, payload);
        return;
      }
      this.#fragmentOpcode = opcode;
      this.#fragments = [payload];
      this.#fragmentSize = payload.length;
      return;
    }
    if (opcode === 0x0 && this.#fragmentOpcode) {
      this.#fragments.push(payload);
      this.#fragmentSize += payload.length;
      if (this.#fragmentSize > MAX_MESSAGE) {
        this.#protocolError(1009);
        return;
      }
      if (fin) {
        const whole = Buffer.concat(this.#fragments);
        const kind = this.#fragmentOpcode;
        this.#fragments = [];
        this.#fragmentOpcode = 0;
        this.#fragmentSize = 0;
        this.#deliver(kind, whole);
      }
      return;
    }
    this.#protocolError(1002);
  }

  #deliver(opcode, payload) {
    if (opcode === 0x1) this.emit('text', payload.toString('utf8'));
    else this.emit('binary', payload);
  }

  #write(opcode, payload) {
    if (!this.#open || this.#socket.destroyed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.#socket.cork();
    this.#socket.write(header);
    this.#socket.write(payload);
    this.#socket.uncork();
  }

  #protocolError(code) {
    this.close(code);
    return null;
  }

  #closed() {
    if (!this.#open) return;
    this.#open = false;
    this.#socket.destroy();
    this.emit('close');
  }
}

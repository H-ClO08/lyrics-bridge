'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 8 * 1024 * 1024;

class WSConnection extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.closed = false;
    this.isAlive = true;
    this.data = {};

    this._buf = Buffer.alloc(0);
    this._fragOpcode = 0;
    this._fragments = [];

    socket.setNoDelay(true);
    socket.setTimeout(0);

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());

    if (head && head.length) this._onData(head);
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(chunk) {
    if (this.closed) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    for (;;) {
      let frame;
      try {
        frame = this._readFrame();
      } catch (err) {
        this.close(1002, 'protocol error');
        return;
      }
      if (!frame) return;
      this._handleFrame(frame);
      if (this.closed) return;
    }
  }

  _readFrame() {
    const b = this._buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const rsv = b[0] & 0x70;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let length = b[1] & 0x7f;
    let offset = 2;

    // 我们从不协商扩展，出现 RSV 位说明对端行为异常
    if (rsv !== 0) throw new Error('unsupported RSV bits');

    if (length === 126) {
      if (b.length < offset + 2) return null;
      length = b.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (b.length < offset + 8) return null;
      const big = b.readBigUInt64BE(offset);
      if (big > BigInt(MAX_PAYLOAD)) throw new Error('payload too large');
      length = Number(big);
      offset += 8;
    }

    if (length > MAX_PAYLOAD) throw new Error('payload too large');

    let maskKey = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      maskKey = b.subarray(offset, offset + 4);
      offset += 4;
    }

    if (b.length < offset + length) return null;

    const payload = Buffer.from(b.subarray(offset, offset + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
    }

    this._buf = b.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    if (opcode === 0x8) {
      this.close(1000, '');
      return;
    }
    if (opcode === 0x9) {
      this._sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) {
      this.isAlive = true;
      return;
    }

    if (opcode === 0x0) {
      if (!this._fragOpcode) return;
      this._fragments.push(payload);
      if (!fin) return;
      const full = Buffer.concat(this._fragments);
      const op = this._fragOpcode;
      this._fragments = [];
      this._fragOpcode = 0;
      this._emitMessage(op, full);
      return;
    }

    if (!fin) {
      this._fragOpcode = opcode;
      this._fragments = [payload];
      return;
    }

    this._emitMessage(opcode, payload);
  }

  _emitMessage(opcode, payload) {
    if (opcode === 0x1) {
      this.emit('message', payload.toString('utf8'));
    } else if (opcode === 0x2) {
      this.emit('binary', payload);
    }
  }

  _sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;

    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;

    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch (err) {
      this._finish();
      return false;
    }
  }

  send(data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return this._sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    return this._sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(String(reason), 'utf8');
    const payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._sendFrame(0x8, payload);
    this.closed = true;
    this.emit('close');
    try {
      this.socket.end();
    } catch (err) {
      /* ignore */
    }
    setTimeout(() => {
      try {
        this.socket.destroy();
      } catch (err) {
        /* ignore */
      }
    }, 1000).unref?.();
  }
}

class WSServer extends EventEmitter {
  constructor(httpServer, path = '/ws') {
    super();
    this.path = path;
    this.clients = new Set();

    httpServer.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));

    // 心跳：清掉已经死掉的浏览器标签页
    this._heartbeat = setInterval(() => {
      for (const conn of this.clients) {
        if (!conn.isAlive) {
          conn.close(1001, 'heartbeat timeout');
          this.clients.delete(conn);
          continue;
        }
        conn.isAlive = false;
        conn.ping();
      }
    }, 30000);
    this._heartbeat.unref?.();
  }

  _handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const url = (req.url || '').split('?')[0];
    if (url !== this.path) {
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (!key || String(version) !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n'
    );

    const conn = new WSConnection(socket, head);
    this.clients.add(conn);
    conn.on('close', () => this.clients.delete(conn));
    this.emit('connection', conn);
  }

  broadcast(data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    for (const conn of this.clients) {
      if (!conn.send(text)) this.clients.delete(conn);
    }
  }

  get size() {
    return this.clients.size;
  }
}

module.exports = { WSServer, WSConnection };

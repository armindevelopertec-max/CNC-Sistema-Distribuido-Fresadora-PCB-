const { EventEmitter } = require('events');

const emitter = new EventEmitter();
let lastPayload = null;

const broadcastRuntimeUpdate = (payload) => {
  lastPayload = payload;
  emitter.emit('update', payload);
};

const attachRuntimeStream = (req, res) => {
  req.socket?.setTimeout(0);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) {
    res.flushHeaders();
  }

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  if (lastPayload) {
    send(lastPayload);
  }

  emitter.on('update', send);

  req.on('close', () => {
    emitter.off('update', send);
  });
};

module.exports = {
  broadcastRuntimeUpdate,
  attachRuntimeStream
};

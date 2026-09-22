// SSE 推送中心：调度台页面实时刷新用
export function createSseHub() {
  const clients = new Set();
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();
  return {
    add(res) {
      clients.add(res);
      res.on('close', () => clients.delete(res));
    },
    broadcast(type, data) {
      const msg = `event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
      for (const res of clients) res.write(msg);
    },
  };
}

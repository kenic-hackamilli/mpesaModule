import type WebSocket from "ws";

export class WebsocketHub {
  private checkoutSubscriptions = new Map<string, Set<WebSocket>>();
  private socketIndex = new Map<WebSocket, Set<string>>();

  register(checkoutId: string, socket: WebSocket) {
    const cleanId = checkoutId.trim();
    if (!cleanId) return;

    const set = this.checkoutSubscriptions.get(cleanId) ?? new Set<WebSocket>();
    set.add(socket);
    this.checkoutSubscriptions.set(cleanId, set);

    const socketKeys = this.socketIndex.get(socket) ?? new Set<string>();
    socketKeys.add(cleanId);
    this.socketIndex.set(socket, socketKeys);
  }

  unregister(socket: WebSocket) {
    const keys = this.socketIndex.get(socket);
    if (!keys) return;

    for (const key of keys) {
      const set = this.checkoutSubscriptions.get(key);
      if (!set) continue;
      set.delete(socket);
      if (set.size === 0) this.checkoutSubscriptions.delete(key);
    }

    this.socketIndex.delete(socket);
  }

  publish(checkoutId: string, payload: any) {
    const set = this.checkoutSubscriptions.get(checkoutId);
    if (!set) return;

    const message = JSON.stringify(payload);
    for (const socket of set) {
      if (socket.readyState === socket.OPEN) {
        socket.send(message);
      }
    }
  }
}

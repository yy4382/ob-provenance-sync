// PROTOTYPE ONLY. Switches and instruments for trying the edit-log bind in a real Obsidian.
// `window.__provenanceProto` is this object, so a CDP driver can flip it and read what happened.

export type ProtoEvent = { t: number; kind: string; [key: string]: unknown };

export const proto = {
  /** true: a pane sends only its own edits at bind (the prototype). false: today's text merge. */
  editLog: true,
  /** Extra wait before a pane's bind is queued, to hold a pane unbound while a driver types. */
  bindDelay: 0,
  /** Throws once from the next bound update that changes the document. */
  throwOnce: false,
  events: [] as ProtoEvent[],
  /** Every document change any pane saw: its user event, how it was classified, and whether the pane was bound. */
  tx: [] as ProtoEvent[],
  anomalies: [] as ProtoEvent[],
  record(kind: string, data: Record<string, unknown> = {}) {
    this.events.push({ t: Date.now(), kind, ...data });
    if (this.events.length > 5000) this.events.shift();
  },
  anomaly(kind: string, data: Record<string, unknown> = {}) {
    const event = { t: Date.now(), kind, ...data };
    this.anomalies.push(event);
    this.events.push(event);
    console.warn("[provenance-proto]", kind, data);
  },
  trace(data: Record<string, unknown>) {
    this.tx.push({ t: Date.now(), kind: "tx", ...data });
    if (this.tx.length > 20000) this.tx.shift();
  },
  reset() {
    this.events = [];
    this.tx = [];
    this.anomalies = [];
  },
};

(globalThis as unknown as { __provenanceProto: typeof proto }).__provenanceProto = proto;

/*
 * Runs the engine in a Web Worker (built from a Blob so it also works on file://).
 * Falls back to the main thread when workers are unavailable.
 */
(function (root) {
  'use strict';

  // Executed inside the worker.
  function workerMain(E) {
    function inflate(b64) {
      const bytes = E.b64ToBytes(b64);
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer().then(buf => new Int8Array(buf));
    }
    let ready = Promise.resolve();
    self.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'init') {
        E.initTT(20);
        if (m.book) E.setBook(m.book);
        ready = m.weights ? inflate(m.weights).then(w => E.setWeights(w)) : Promise.resolve();
        ready.then(() => self.postMessage({ type: 'ready' }), (e) => self.postMessage({ type: 'ready', error: String(e) }));
      } else if (m.type === 'think') {
        ready.then(() => {
          const opts = Object.assign({}, m.opts, {
            onInfo: (info) => self.postMessage({ type: 'info', id: m.id, info }),
          });
          const r = E.think(m.pos, opts);
          self.postMessage({ type: 'result', id: m.id, result: r });
        });
      }
    };
  }

  function AIClient(data) {
    this.data = data;            // { weights: base64 | null, book: object | null }
    this.id = 0;
    this.pending = null;
    this.worker = null;
    this.local = null;
    this._spawn();
  }
  AIClient.prototype._spawn = function () {
    try {
      const src = 'const E = (' + root.OthelloEngineFactory.toString() + ')();\n(' + workerMain.toString() + ')(E);';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      this.worker = new Worker(url);
      this.worker.onmessage = (ev) => this._onMessage(ev.data);
      this.worker.onerror = () => { this._fallback(); };
      this.worker.postMessage({ type: 'init', weights: this.data.weights, book: this.data.book });
    } catch (e) {
      this._fallback();
    }
  };
  // main-thread engine (blocks the UI while thinking, but keeps the game playable)
  AIClient.prototype._fallback = function () {
    if (this.worker) { try { this.worker.terminate(); } catch (e) { /* ignore */ } }
    this.worker = null;
    if (this.local) return;
    const E = root.OthelloEngineFactory();
    E.initTT(18);
    if (this.data.book) E.setBook(this.data.book);
    this.local = { E, ready: Promise.resolve() };
    if (this.data.weights && typeof DecompressionStream !== 'undefined') {
      const bytes = E.b64ToBytes(this.data.weights);
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      this.local.ready = new Response(stream).arrayBuffer().then(b => E.setWeights(new Int8Array(b))).catch(() => { });
    }
    if (this.pending) { const p = this.pending; this.pending = null; this.think(p.pos, p.opts, p.onInfo).then(p.resolve); }
  };
  AIClient.prototype._onMessage = function (m) {
    const p = this.pending;
    if (!p || m.id !== p.id) return;
    if (m.type === 'info') { if (p.onInfo) p.onInfo(m.info); }
    else if (m.type === 'result') { this.pending = null; p.resolve(m.result); }
  };
  // resolves with the engine result; a cancelled request never resolves
  AIClient.prototype.think = function (pos, opts, onInfo) {
    const id = ++this.id;
    const clean = Object.assign({}, opts); delete clean.rng;
    return new Promise((resolve) => {
      this.pending = { id, pos, opts: clean, onInfo, resolve };
      if (this.worker) this.worker.postMessage({ type: 'think', id, pos, opts: clean });
      else {
        const L = this.local;
        L.ready.then(() => setTimeout(() => {
          if (!this.pending || this.pending.id !== id) return;
          this.pending = null;
          resolve(L.E.think(pos, clean));
        }, 30));
      }
    });
  };
  AIClient.prototype.cancel = function () {
    if (!this.pending) return;
    this.pending = null;
    if (this.worker) { this.worker.terminate(); this._spawn(); }
  };

  root.OthelloAIClient = AIClient;
})(typeof self !== 'undefined' ? self : this);

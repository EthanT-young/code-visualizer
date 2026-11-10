// Runs code and reports traces: Python in a Web Worker (Pyodide), Java and C++ on the server.
import { LANGUAGES } from './examples.js';

const RUN_TIMEOUT_MS = 12000;

// Absolute URLs built from location (which never holds credentials). Relative URLs
// resolve against the document's base URL, which keeps "user:pass@" when someone opens
// https://user:pass@host/…, and the browser then refuses the request.
export const appUrl = (path) => new URL(path, `${location.origin}${location.pathname}`).href;

export class Runner {
  /**
   * @param {object} callbacks
   * @param {(trace: object, reset: boolean) => void} callbacks.onTrace
   * @param {(text: string, kind?: string) => void} callbacks.onNotice  status message while not showing a trace
   * @param {(busy: boolean) => void} callbacks.onBusy
   */
  constructor({ onTrace, onNotice, onBusy }) {
    this.onTrace = onTrace;
    this.onNotice = onNotice;
    this.onBusy = onBusy;
    this.worker = null;
    this.ready = false;
    this.runId = 0;
    this.pending = null; // { id, reset }
    this.queued = null; // Python run requested while Python is loading
    this.skipNextQueued = false;
    this.request = null;
    this.killTimer = null;
  }

  startWorker() {
    this.ready = false;
    const worker = new Worker(appUrl('worker.js'));
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'ready') {
        this.ready = true;
        const queued = this.queued;
        this.queued = null;
        if (this.skipNextQueued) this.skipNextQueued = false;
        else if (queued) this.run(queued);
      } else if (msg.type === 'fatal') {
        this.onBusy(false);
        this.onNotice(`Python couldn't load (${msg.error}). Check your internet connection, then reload the page.`, 'error');
      } else if (msg.type === 'result') {
        this.finish(msg.id, () => JSON.parse(msg.json));
      }
    };
    worker.onerror = (event) => {
      this.onBusy(false);
      this.onNotice(`Python couldn't start: ${event.message || 'unknown error'}.`, 'error');
    };
    this.worker = worker;
  }

  finish(id, getTrace) {
    if (!this.pending || id !== this.pending.id) return;
    clearTimeout(this.killTimer);
    const { reset } = this.pending;
    this.pending = null;
    let trace;
    try {
      trace = getTrace();
    } catch {
      trace = { ok: false, steps: [], stdout: '', error: 'The visualizer received a broken trace.', line: null };
    }
    this.onBusy(false);
    this.onTrace(trace, reset);
  }

  /** Forget any run in flight (e.g. when switching languages). */
  cancel() {
    if (this.request) this.request.abort();
    this.pending = null;
    this.queued = null;
    clearTimeout(this.killTimer);
    this.onBusy(false);
  }

  run({ lang, code, stdin, reset = false }) {
    // Code copied from web pages can contain non-breaking spaces, which compilers reject.
    code = code.replaceAll('\u00a0', ' ');
    const id = ++this.runId;
    // A newer run replaces an older one; keep "reset" if any replaced run asked for it.
    this.pending = { id, reset: reset || Boolean(this.pending && this.pending.reset) };
    this.onBusy(true);
    clearTimeout(this.killTimer);

    if (lang === 'python') {
      if (!this.worker) this.startWorker();
      if (!this.ready) {
        this.queued = { lang, code, stdin, reset: this.pending.reset };
        this.pending = null;
        this.onNotice('Loading Python in your browser. The first load takes a few seconds.');
        return;
      }
      this.worker.postMessage({ id, code, stdin });
      this.killTimer = setTimeout(() => {
        if (!this.pending || this.pending.id !== id) return;
        this.pending = null;
        this.worker.terminate();
        this.worker = null;
        this.skipNextQueued = true;
        this.onBusy(false);
        this.onNotice(`Stopped after ${RUN_TIMEOUT_MS / 1000} seconds without finishing. Look for a loop that never ends, then edit the code or press Run.`, 'error');
        this.startWorker();
      }, RUN_TIMEOUT_MS);
      return;
    }

    if (this.request) this.request.abort();
    const controller = new AbortController();
    this.request = controller;
    fetch(appUrl('api/trace'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: lang, code, stdin }),
      signal: controller.signal,
    })
      .then(async (res) => {
        // 400, 413 and 429 carry an explanation in the same format as a trace.
        if (!res.ok && ![400, 413, 429].includes(res.status)) throw new Error(`server responded ${res.status}`);
        const trace = await res.json();
        this.finish(id, () => trace);
      })
      .catch((err) => {
        if (err.name === 'AbortError' || !this.pending || this.pending.id !== id) return;
        this.pending = null;
        this.onBusy(false);
        this.onNotice(`Couldn't reach the server that runs ${LANGUAGES[lang].label} code (${err.message}). Python still works without it.`, 'error');
      });
  }
}

/* Runs Python (Pyodide) off the main thread so long programs never freeze the page. */
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
importScripts(PYODIDE_URL + 'pyodide.js');

const ready = (async () => {
  const pyodide = await loadPyodide({ indexURL: PYODIDE_URL });
  const here = `${self.location.origin}${self.location.pathname}`;
  const source = await (await fetch(new URL('tracer.py', here))).text();
  pyodide.runPython(source);
  const runTrace = pyodide.globals.get('run_trace');
  postMessage({ type: 'ready' });
  return runTrace;
})();

ready.catch((err) => postMessage({ type: 'fatal', error: String(err && err.message || err) }));

self.onmessage = async (event) => {
  const { id, code, stdin } = event.data;
  let json;
  try {
    const runTrace = await ready;
    json = runTrace(code, stdin || '');
  } catch (err) {
    json = JSON.stringify({ ok: false, steps: [], stdout: '', error: String(err && err.message || err), line: null });
  }
  postMessage({ type: 'result', id, json });
};

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { normalizeInitialUrl } from './lib/router';

// After a redeploy, a page opened for the first time may request a chunk from the previous build, which now 404s.
// Reload once to pick up the new build instead of letting React unmount the whole app; the guard prevents a loop.
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem('qanary:chunk-reload') ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem('qanary:chunk-reload', String(Date.now()));
  } catch {
    // Storage blocked: still reload once.
  }
  event.preventDefault();
  window.location.reload();
});

normalizeInitialUrl();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

(() => {
  'use strict';
  const protocol = 'portfolio-link-v1';
  const parameters = new URLSearchParams(location.hash.slice(1));
  const linkKey = parameters.get('key') || '';
  const encoder = new TextEncoder();
  const blobURLs = new Set();
  const images = new Map();
  const pending = new WeakMap();
  const queue = [];
  const controller = new AbortController();
  const manifestPath = document.querySelector('meta[name="reader-manifest"]')?.content;
  const manifestHash = document.querySelector('meta[name="reader-manifest-sha256"]')?.content;
  const mirrorBase = document.querySelector('meta[name="reader-mirror"]')?.content || '';
  const mirrorAllowed = /^https:\/\/cdn\.jsdelivr\.net\/gh\/lizelin0413-spec\/view-e357386377cd6345@[a-f0-9]{40}\/$/.test(mirrorBase);
  const retryTimers = new Set();
  let spreads = [];
  let active = 0;
  let disposed = false;
  let expiresAt = Infinity;
  let deadlineTimer;

  function locked(message = '请使用完整的作品集链接', detail = '请打开作品集所有者发来的完整链接。') {
    if (disposed) return;
    dispose();
    document.title = '作品阅读';
    if (!document.querySelector('link[href="./gate.css"]')) {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet'; stylesheet.href = './gate.css'; document.head.append(stylesheet);
    }
    document.body.className = 'link-gate';
    document.body.replaceChildren();
    const panel = document.createElement('main');
    panel.className = 'link-panel';
    const eyebrow = document.createElement('small');
    eyebrow.textContent = 'PRIVATE VIEW';
    const title = document.createElement('h1');
    title.textContent = message;
    const description = document.createElement('p');
    description.textContent = detail;
    panel.append(eyebrow, title, description);
    document.body.append(panel);
  }

  function dispose() {
    disposed = true;
    clearTimeout(deadlineTimer);
    controller.abort();
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    queue.length = 0;
    lazyObserver.disconnect();
    for (const url of blobURLs) URL.revokeObjectURL(url);
    blobURLs.clear();
    images.clear();
  }

  function pump() {
    while (!disposed && active < 4 && queue.length) {
      const current = Number(new URLSearchParams(location.hash.slice(1)).get('view')) || 0;
      const visible = new Set((spreads[current] || []).map(n => `page:${String(n).padStart(3, '0')}`));
      const zooming = document.querySelector('#zoom-dialog[open]');
      const zoomJob = zooming ? queue.findIndex(job => job.id.startsWith('zoom:')) : -1;
      const urgent = zoomJob >= 0 ? zoomJob : queue.findIndex(job => visible.has(job.id));
      if (urgent > 0) queue.unshift(queue.splice(urgent, 1)[0]);
      const job = queue.shift();
      active++;
      job.run().then(job.resolve, job.reject).finally(() => { active--; pump(); });
    }
  }

  function enqueue(run, id) {
    return new Promise((resolve, reject) => { queue.push({ run, resolve, reject, id }); pump(); });
  }

  const lazyObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      lazyObserver.unobserve(entry.target);
      const run = pending.get(entry.target);
      pending.delete(entry.target);
      run?.();
    }
  }, { rootMargin: '700px' });

  async function fetchBytes(path, immutable = false, validate = bytes => bytes) {
    const routes = [new URL(path, location.href).href];
    if (mirrorAllowed && /^\.\/vault\/[a-f0-9]{32}\.bin$/.test(path)) routes.push(new URL(path, mirrorBase).href);
    const group = new AbortController();
    const cancel = () => group.abort();
    controller.signal.addEventListener('abort', cancel, { once: true });
    if (controller.signal.aborted) group.abort();
    let startBackup;
    const backupReady = new Promise(resolve => { startBackup = resolve; });
    const hedgeTimer = setTimeout(() => startBackup(), 900);
    async function attempt(url, index) {
      if (index) await backupReady;
      if (group.signal.aborted) throw new Error('Request cancelled');
      const route = new AbortController();
      const cancelRoute = () => route.abort();
      group.signal.addEventListener('abort', cancelRoute, { once: true });
      if (group.signal.aborted) route.abort();
      const timer = setTimeout(cancelRoute, 15000);
      try {
        const response = await fetch(url, {
          cache: immutable ? 'force-cache' : 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: route.signal
        });
        if (!response.ok) throw new Error('Resource unavailable');
        // Keep the deadline active through the body read and integrity check.
        return await validate(new Uint8Array(await response.arrayBuffer()));
      } catch (error) { if (!index) startBackup(); throw error; }
      finally { clearTimeout(timer); group.signal.removeEventListener('abort', cancelRoute); }
    }
    try { return await Promise.any(routes.map(attempt)); }
    finally { clearTimeout(hedgeTimer); group.abort(); startBackup(); controller.signal.removeEventListener('abort', cancel); }
  }

  async function start() {
    if (!/^[A-Za-z0-9_-]{43}$/.test(linkKey)) { locked(); return; }
    if (!crypto.subtle) {
      locked('当前浏览器无法打开', '请使用新版浏览器，通过 HTTPS 完整链接访问。');
      return;
    }
    const rawKey = Uint8Array.from(atob(linkKey.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    async function decrypt(bytes, label) {
      if (bytes.length < 29) throw new Error('Incomplete resource');
      return crypto.subtle.decrypt({
        name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: encoder.encode(`${protocol}:${label}`), tagLength: 128
      }, key, bytes.subarray(12));
    }
    const path = manifestPath || JSON.parse(new TextDecoder().decode(await fetchBytes('./link.json'))).manifest;
    const metadata = await fetchBytes(path, false, async bytes => {
      if (manifestHash) {
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
        if (hash !== manifestHash) throw new Error('Publication version mismatch');
      }
      return bytes;
    });
    const manifest = JSON.parse(new TextDecoder().decode(await decrypt(metadata, 'manifest')));
    if (disposed) return;
    if (manifest.protocol !== protocol || manifest.portfolio.pageCount !== 92) throw new Error('Invalid publication');
    spreads = manifest.portfolio.spreads;
    expiresAt = Date.parse(manifest.config.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error('Invalid expiry');
    if (Date.now() >= expiresAt) { locked('作品集已到期', '当前链接已停止显示，请联系作品集所有者。'); return; }

    function imageBlob(n, kind) {
      const id = `${kind}:${String(n).padStart(3, '0')}`;
      if (!images.has(id)) {
        const record = manifest.images[id];
        if (!record) return Promise.reject(new Error('Unknown image'));
        const promise = enqueue(async () => {
          const label = record.aadLabel || id;
          if (label !== id && !(kind === 'zoom' && label === id.replace('zoom:', 'page:'))) throw new Error('Invalid image label');
          const data = await fetchBytes(record.path, true, bytes => decrypt(bytes, label));
          if (disposed) throw new Error('Reader closed');
          const url = URL.createObjectURL(new Blob([data], { type: 'image/webp' }));
          blobURLs.add(url);
          return url;
        }, id);
        images.set(id, promise);
        promise.catch(() => images.delete(id));
      }
      return images.get(id);
    }

    function loadImage(img, n, thumb = false) {
      if (disposed) return;
      const kind = thumb === 'zoom' ? 'zoom' : thumb ? 'thumb' : 'page';
      img.dataset.privatePage = String(n);
      img.dataset.privateKind = kind;
      const matching = () => document.querySelectorAll(`img[data-private-page="${n}"][data-private-kind="${kind}"]`);
      let attempts = 0;
      const load = () => {
        attempts++;
        for (const target of matching()) {
          delete target.dataset.loadError;
          const status = target.parentElement.querySelector('.reader-image-status');
          if (status) status.textContent = '正在加载…';
        }
        return imageBlob(n, kind).then(url => {
          if (disposed) return;
          // PageFlip clones a page during a turn; update that copy as well.
          for (const target of matching()) {
            target.src = url; target.dataset.loaded = 'true'; delete target.dataset.loadError;
            target.alt = `作品集第 ${n} 页`;
            target.parentElement.querySelector('.reader-image-status')?.remove();
          }
        }).catch(() => {
          if (disposed) return;
          for (const target of matching()) {
            target.dataset.loadError = 'true'; target.alt = `第 ${n} 页暂未加载`;
            const status = target.parentElement.querySelector('.reader-image-status');
            if (status) status.textContent = attempts < 2 ? '正在重新连接…' : '加载失败，点击重试';
          }
          if (attempts < 2) {
            const timer = setTimeout(() => { retryTimers.delete(timer); if (!disposed && matching().length) load(); }, 1200);
            retryTimers.add(timer);
          }
        });
      };
      queueMicrotask(() => {
        if (disposed || !img.isConnected) return;
        if (img.parentElement.classList.contains('book-page') && !img.parentElement.querySelector('.reader-image-status')) {
          const status = document.createElement('span'); status.className = 'reader-image-status'; status.textContent = '正在加载…'; img.parentElement.append(status);
        }
        if (img.loading === 'lazy') { pending.set(img, load); lazyObserver.observe(img); }
        else load();
      });
    }

    const parsed = new DOMParser().parseFromString(manifest.html, 'text/html');
    for (const script of parsed.querySelectorAll('script')) script.remove();
    document.head.replaceChildren(...Array.from(parsed.head.childNodes, node => document.importNode(node, true)));
    document.body.replaceWith(document.importNode(parsed.body, true));
    const statusStyle = document.createElement('style');
    statusStyle.textContent = '.book-page{position:relative}.reader-image-status{position:absolute;inset:0;display:grid;place-items:center;background:#171918;color:#b5b1a7;font:13px/1.6 sans-serif;pointer-events:none}.book-page:has(img[data-load-error]){cursor:pointer}';
    document.head.append(statusStyle);
    document.addEventListener('click', event => {
      const target = event.target.closest('.book-page')?.querySelector('img[data-load-error]');
      if (target) { event.preventDefault(); event.stopImmediatePropagation(); loadImage(target, Number(target.dataset.privatePage)); }
    }, true);
    window.PORTFOLIO = manifest.portfolio;
    window.VIEWER_CONFIG = manifest.config;
    window.PRIVATE_READER = { loadImage, dispose };
    const library = document.createElement('script');
    library.src = './vendor/page-flip.browser.js';
    await new Promise((resolve, reject) => { library.onload = resolve; library.onerror = reject; document.head.append(library); });
    if (disposed) return;
    const appURL = URL.createObjectURL(new Blob([manifest.app], { type: 'text/javascript' }));
    blobURLs.add(appURL);
    const appScript = document.createElement('script');
    appScript.src = appURL;
    await new Promise((resolve, reject) => { appScript.onload = resolve; appScript.onerror = reject; document.head.append(appScript); });
    const checkDeadline = () => {
      if (disposed) return;
      if (Date.now() >= expiresAt) { locked('作品集已到期', '当前链接已停止显示，请联系作品集所有者。'); return; }
      deadlineTimer = setTimeout(checkDeadline, Math.min(expiresAt - Date.now() + 50, 86400000));
    };
    checkDeadline();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !disposed && Date.now() >= expiresAt) locked('作品集已到期', '当前链接已停止显示，请联系作品集所有者。'); });
  }

  window.addEventListener('hashchange', event => {
    const nextKey = new URLSearchParams(location.hash.slice(1)).get('key') || '';
    if (nextKey === linkKey) return;
    event.stopImmediatePropagation();
    if (!disposed) locked();
    if (nextKey) location.reload();
  });
  start().catch(() => locked('链接无法验证', '请确认使用了完整链接，或稍后刷新重试。'));
})();

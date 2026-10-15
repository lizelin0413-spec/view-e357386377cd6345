(() => {
  'use strict';
  const protocol = 'portfolio-link-v1';
  const parameters = new URLSearchParams(location.hash.slice(1));
  const linkKey = parameters.get('key') || '';
  const encoder = new TextEncoder();
  const blobURLs = new Set();
  const images = new Map();
  const readyImages = new Set();
  const pending = new WeakMap();
  const queue = [];
  const jobs = new Map();
  const controller = new AbortController();
  let active = 0;
  let backgroundActive = 0;
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
    queue.length = 0;
    jobs.clear();
    lazyObserver.disconnect();
    for (const url of blobURLs) URL.revokeObjectURL(url);
    blobURLs.clear();
    images.clear();
    readyImages.clear();
  }

  function pump() {
    queue.sort((a, b) => a.priority - b.priority);
    while (!disposed && active < 4 && queue.length) {
      if (queue[0].priority > 0 && (active > backgroundActive || backgroundActive >= 1)) break;
      const job = queue.shift();
      const background = job.priority > 0;
      active++;
      if (background) backgroundActive++;
      job.run().then(job.resolve, job.reject).finally(() => {
        jobs.delete(job.id);
        active--;
        if (background) backgroundActive--;
        pump();
      });
    }
  }

  function enqueue(id, run, priority) {
    return new Promise((resolve, reject) => {
      const job = { id, run, resolve, reject, priority };
      jobs.set(id, job);
      queue.push(job);
      pump();
    });
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

  async function fetchBytes(path, immutable = false) {
    const response = await fetch(new URL(path, location.href), {
      cache: immutable ? 'force-cache' : 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal
    });
    if (!response.ok) throw new Error('Resource unavailable');
    return new Uint8Array(await response.arrayBuffer());
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
    const descriptor = await fetchBytes('./link.json');
    const publicConfig = JSON.parse(new TextDecoder().decode(descriptor));
    const manifest = JSON.parse(new TextDecoder().decode(await decrypt(await fetchBytes(publicConfig.manifest), 'manifest')));
    if (disposed) return;
    if (manifest.protocol !== protocol || manifest.portfolio.pageCount !== 92) throw new Error('Invalid publication');
    expiresAt = Date.parse(manifest.config.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error('Invalid expiry');
    if (Date.now() >= expiresAt) { locked('作品集已到期', '当前链接已停止显示，请联系作品集所有者。'); return; }

    function imageBlob(n, thumb, background) {
      const id = `${thumb ? 'thumb' : 'page'}:${String(n).padStart(3, '0')}`;
      const priority = background ? 2 : 0;
      const queued = jobs.get(id);
      if (queued && priority < queued.priority) { queued.priority = priority; pump(); }
      if (!images.has(id)) {
        const record = manifest.images[id];
        if (!record) return Promise.reject(new Error('Unknown image'));
        const promise = enqueue(id, async () => {
          const data = await decrypt(await fetchBytes(record.path, true), id);
          if (disposed) throw new Error('Reader closed');
          const url = URL.createObjectURL(new Blob([data], { type: 'image/webp' }));
          blobURLs.add(url);
          readyImages.add(id);
          return url;
        }, priority);
        images.set(id, promise);
        promise.catch(() => images.delete(id));
      }
      return images.get(id);
    }

    function loadImage(img, n, thumb = false, background = false) {
      if (disposed) return;
      img.dataset.privatePage = String(n);
      const load = () => {
        const complete = imageBlob(n, thumb, background);
        const id = `page:${String(n).padStart(3, '0')}`;
        if (!thumb && !background && n !== 1 && n !== 92 && !readyImages.has(id)) {
          imageBlob(n, true, false).then(url => {
            if (!disposed && img.isConnected && img.dataset.loaded !== 'true') {
              img.src = url; img.dataset.preview = 'true';
            }
          }).catch(() => { /* The full-resolution image remains the primary load. */ });
        }
        return complete.then(url => {
          if (!disposed && img.isConnected) { img.src = url; img.dataset.loaded = 'true'; delete img.dataset.preview; }
        }).catch(() => {
          if (!disposed) { img.dataset.loadError = 'true'; img.alt = `第 ${n} 页暂未加载，请刷新后重试`; }
        });
      };
      queueMicrotask(() => {
        if (disposed || !img.isConnected) return;
        if (img.loading === 'lazy') { pending.set(img, load); lazyObserver.observe(img); }
        else load();
      });
    }

    const parsed = new DOMParser().parseFromString(manifest.html, 'text/html');
    for (const script of parsed.querySelectorAll('script')) script.remove();
    document.head.replaceChildren(...Array.from(parsed.head.childNodes, node => document.importNode(node, true)));
    document.body.replaceWith(document.importNode(parsed.body, true));
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

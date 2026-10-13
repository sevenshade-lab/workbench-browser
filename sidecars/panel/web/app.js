(() => {
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.search).get('token') || '';
  const view = $('view');
  const canvas = $('screen');
  const ime = $('ime');
  const urlInput = $('url');
  const veil = $('veil');
  const context = canvas.getContext('2d', { alpha: false });

  let transport = null;
  let retries = 0;
  let state = { tabs: [], active: null, running: false, starting: true, error: '' };
  let sent = { width: 0, height: 0, dpr: 0 };
  let hasFrame = false;

  const send = (message) => {
    if (transport) transport.send(message);
  };
  const activeTab = () => state.tabs.find((tab) => tab.id === state.active) || null;
  const listeners = new Map();

  // ---------- 和后台的连接 ----------
  //
  // 这个页面不是从后台直接打开的：Antigravity 把它挂在 plugin://… 下面，普通请求由它转给后台，
  // 长连接它不转。所以先用普通请求问到后台的真实端口，再直接连过去；直连不上就全用普通请求。

  function call(path, body = {}) {
    const options = { method: 'POST', body: JSON.stringify(body) };
    return window.sidecar
      ? window.sidecar.fetch(path, options)
      : fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': token } });
  }

  async function api(path, body) {
    try {
      return await (await call(path, body)).json();
    } catch (error) {
      return { ok: false, error: '插件后台没有响应' };
    }
  }

  // 面板这头出的事报给后台记进日志，排查时不用截图。
  const tell = (text) => {
    call('/api/client-log', { text }).catch(() => {});
  };
  document.addEventListener('securitypolicyviolation', (event) => tell(`被安全策略拦截：${event.violatedDirective} ${event.blockedURI}`));
  window.addEventListener('error', (event) => tell(`脚本出错：${event.message} @${event.lineno}`));

  async function connect() {
    transport = null;
    if (!hasFrame) showVeil('正在连接插件后台');
    const link = await api('/api/link');
    if (!link.ok) {
      retries += 1;
      showVeil(retries > 5 ? '连不上插件后台。插件可能刚重启过：请关掉这个面板再重新打开' : '正在连接插件后台');
      setTimeout(connect, Math.min(5000, 500 * 2 ** retries));
      return;
    }
    try {
      // 地址里带 transport=poll 是测试用的开关：跳过直连，专门走后备路。
      if (new URLSearchParams(location.search).get('transport') === 'poll') throw new Error('测试开关');
      transport = await openSocket(link);
      tell(`面板已连上（直连，页面在 ${location.protocol}//${location.host}）`);
    } catch (error) {
      tell(`直连不通（${error.message}），改用普通请求`);
      transport = openPolling(link);
    }
    retries = 0;
    sent = { width: 0, height: 0, dpr: 0 };
    reportSize();
  }

  function lost() {
    transport = null;
    hasFrame = false;
    showVeil('连接断开，正在重连');
    setTimeout(connect, Math.min(5000, 500 * 2 ** retries++));
  }

  function openSocket(link) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(`ws://127.0.0.1:${link.port}/ws?key=${link.key}`);
      } catch (error) {
        reject(error);
        return;
      }
      socket.binaryType = 'arraybuffer';
      let opened = false;
      const timer = setTimeout(() => {
        if (opened) return;
        reject(new Error('3 秒没连上'));
        socket.close();
      }, 3000);
      socket.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve({
          send: (message) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
          },
        });
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') onMessage(JSON.parse(event.data));
        else drawFrame(event.data);
      };
      socket.onclose = () => {
        clearTimeout(timer);
        if (opened) lost();
        else reject(new Error('被拒绝或被拦截'));
      };
    });
  }

  function openPolling(link) {
    let alive = true;
    let frameSeq = 0;
    let failures = 0;
    const outbox = [];
    let sending = false;
    const pump = async () => {
      if (sending) return;
      sending = true;
      while (alive && outbox.length) {
        const batch = outbox.splice(0);
        try {
          await call('/api/input', { session: link.session, messages: batch });
        } catch {
          // 这一批丢了；鼠标键盘是连续的，后面的照发
        }
      }
      sending = false;
    };
    (async () => {
      while (alive) {
        try {
          const response = await call('/api/poll', { session: link.session, frameSeq });
          if (!response.ok || !(response.headers.get('content-type') || '').includes('octet-stream')) throw new Error('后台不认这个会话');
          const buffer = await response.arrayBuffer();
          if (!alive) return;
          const headLength = new DataView(buffer).getUint32(0);
          const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headLength)));
          for (const message of head.messages) onMessage(message);
          if (head.frameSeq > frameSeq) {
            frameSeq = head.frameSeq;
            drawFrame(buffer.slice(4 + headLength));
          }
          failures = 0;
        } catch {
          failures += 1;
          if (failures > 3) {
            alive = false;
            lost();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
    })();
    return {
      send: (message) => {
        outbox.push(message);
        pump();
      },
    };
  }

  function onMessage(message) {
    switch (message.t) {
      case 'state':
        state = message;
        if (!state.running) hasFrame = false;
        retryStart();
        render();
        break;
      case 'select':
        openSelectMenu(message);
        break;
      case 'cursor':
        canvas.style.cursor = /^[a-z-]{1,24}$/.test(message.cursor) ? message.cursor : 'default';
        break;
      case 'clipboard':
        copyLocal(message.text);
        break;
      case 'error':
        toast(message.message);
        break;
      default:
        for (const handler of listeners.get(message.t) || []) handler(message);
        break;
    }
  }

  // 浏览器没起来时自己再试几次（最常见的原因是上一个浏览器还没退干净，等几秒就好），不用人去点「重试」。
  let startRetries = 0;
  let startTimer = 0;
  function retryStart() {
    if (state.running) {
      startRetries = 0;
      return;
    }
    if (!state.error || state.starting || startRetries >= 4) return;
    startRetries += 1;
    clearTimeout(startTimer);
    startTimer = setTimeout(() => send({ t: 'start' }), 3000);
  }

  // ---------- 画面 ----------

  let drawing = false;
  let queued = null;
  async function drawFrame(buffer) {
    if (drawing) {
      queued = buffer;
      return;
    }
    drawing = true;
    try {
      const type = new Uint8Array(buffer, 0, 1)[0] === 0x89 ? 'image/png' : 'image/jpeg';
      const bitmap = await createImageBitmap(new Blob([buffer], { type }));
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      if (!hasFrame) {
        hasFrame = true;
        renderVeil();
      }
    } catch {
      // 坏帧，等下一帧
    } finally {
      drawing = false;
      if (queued) {
        const next = queued;
        queued = null;
        drawFrame(next);
      }
    }
  }

  let resizeTimer = 0;
  function reportSize() {
    const box = view.getBoundingClientRect();
    const width = Math.round(box.width);
    const height = Math.round(box.height);
    if (width < 50 || height < 50) return;
    const dpr = Math.round((window.devicePixelRatio || 1) * 100) / 100;
    if (width === sent.width && height === sent.height && dpr === sent.dpr) return;
    sent = { width, height, dpr };
    send({ t: 'resize', width, height, dpr });
  }
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reportSize, 120);
  }).observe(view);

  function showVeil(text, retry = false) {
    $('veilText').textContent = text;
    $('veilRetry').hidden = !retry;
    veil.hidden = false;
  }

  function renderVeil() {
    const tab = activeTab();
    if (state.error) showVeil(state.error, true);
    else if (tab && tab.crashed) showVeil('这个页面崩溃了', true);
    else if (!state.running || !hasFrame) showVeil('正在启动浏览器');
    else veil.hidden = true;
  }

  $('veilRetry').onclick = () => {
    const tab = activeTab();
    if (state.running && tab && tab.crashed) send({ t: 'reload' });
    else send({ t: 'start' });
    showVeil('正在启动浏览器');
  };

  // ---------- 鼠标 ----------

  const modifiers = (event) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  function pointOf(event) {
    const box = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - box.left) * (sent.width / box.width || 1),
      y: (event.clientY - box.top) * (sent.height / box.height || 1),
    };
  }

  let pendingMove = null;
  let pendingWheel = null;
  let flushScheduled = false;
  function flushPointer() {
    flushScheduled = false;
    if (pendingMove) {
      send(pendingMove);
      pendingMove = null;
    }
    if (pendingWheel) {
      send(pendingWheel);
      pendingWheel = null;
    }
  }
  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(flushPointer);
  }

  let lastDown = { time: 0, x: 0, y: 0, button: -1, count: 0 };
  canvas.addEventListener('pointerdown', (event) => {
    closeSelectMenu();
    flushPointer();
    const point = pointOf(event);
    const again = event.button === lastDown.button
      && event.timeStamp - lastDown.time < 450
      && Math.hypot(point.x - lastDown.x, point.y - lastDown.y) < 6;
    lastDown = { time: event.timeStamp, x: point.x, y: point.y, button: event.button, count: again ? lastDown.count + 1 : 1 };
    canvas.setPointerCapture(event.pointerId);
    const box = view.getBoundingClientRect();
    ime.style.left = Math.max(0, Math.min(box.width - 4, event.clientX - box.left)) + 'px';
    ime.style.top = Math.max(0, Math.min(box.height - 22, event.clientY - box.top)) + 'px';
    ime.focus({ preventScroll: true });
    send({ t: 'mouse', type: 'down', ...point, button: event.button, buttons: event.buttons, clickCount: lastDown.count, mods: modifiers(event) });
  });
  // 不拦这个的话，点一下画面焦点就从隐形输入框跑掉了，键盘接不住。
  canvas.addEventListener('mousedown', (event) => event.preventDefault());
  canvas.addEventListener('pointermove', (event) => {
    pendingMove = { t: 'mouse', type: 'move', ...pointOf(event), buttons: event.buttons, mods: modifiers(event) };
    scheduleFlush();
  });
  canvas.addEventListener('pointerup', (event) => {
    flushPointer();
    send({ t: 'mouse', type: 'up', ...pointOf(event), button: event.button, buttons: event.buttons, clickCount: lastDown.count, mods: modifiers(event) });
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? sent.height : 1;
    const previous = pendingWheel || { dx: 0, dy: 0 };
    pendingWheel = {
      t: 'mouse',
      type: 'wheel',
      ...pointOf(event),
      dx: previous.dx + event.deltaX * unit,
      dy: previous.dy + event.deltaY * unit,
      mods: modifiers(event),
    };
    scheduleFlush();
  }, { passive: false });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  // ---------- 键盘、输入法、剪贴板 ----------

  const keyMessage = (event, type) => ({
    t: 'key',
    type,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    location: event.location,
    repeat: event.repeat,
    mods: modifiers(event),
  });

  ime.addEventListener('keydown', (event) => {
    // 输入法正在组字：这些按键是给输入法的，不往页面送。
    if (event.isComposing || event.keyCode === 229) return;
    const command = (event.ctrlKey || event.metaKey) && !event.altKey;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (command && key === 'v') return; // 交给下面的 paste 事件，才拿得到系统剪贴板里的字
    event.preventDefault();
    if (command && key === 'l') {
      urlInput.focus();
      urlInput.select();
      return;
    }
    if (key === 'F5' || (command && key === 'r')) {
      send({ t: 'reload' });
      return;
    }
    if (event.altKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      send({ t: key === 'ArrowLeft' ? 'back' : 'forward' });
      return;
    }
    const message = keyMessage(event, 'down');
    if (event.key.length === 1 && !command && !event.altKey) message.text = event.key;
    else if (event.key === 'Enter') message.text = '\r';
    send(message);
    if (command && (key === 'c' || key === 'x')) send({ t: 'copy' });
  });
  ime.addEventListener('keyup', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    event.preventDefault();
    send(keyMessage(event, 'up'));
  });

  let composing = false;
  ime.addEventListener('compositionstart', () => { composing = true; });
  ime.addEventListener('compositionend', (event) => {
    composing = false;
    if (event.data) send({ t: 'text', text: event.data });
    ime.value = '';
  });
  // 不经过组字直接上屏的东西（中文标点、表情面板、语音输入）走这里。
  ime.addEventListener('input', (event) => {
    if (composing || event.isComposing) return;
    if (ime.value) send({ t: 'text', text: ime.value });
    ime.value = '';
  });
  ime.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
    if (text) send({ t: 'paste', text });
  });

  async function copyLocal(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 面板在沙箱 iframe 里，这个接口可能不给用，退回老办法
    }
    const focused = document.activeElement;
    const holder = document.createElement('textarea');
    holder.value = text;
    holder.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(holder);
    holder.select();
    try {
      document.execCommand('copy');
    } catch {
      toast('复制失败');
    }
    holder.remove();
    if (focused && focused.focus) focused.focus({ preventScroll: true });
  }

  // ---------- 标签页与地址栏 ----------

  const hostOf = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  };

  function renderTabs() {
    const strip = $('tabs');
    strip.replaceChildren(...state.tabs.map((tab) => {
      const item = document.createElement('div');
      item.className = 'tab';
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(tab.id === state.active));
      const label = tab.url === 'about:blank' ? '新标签页' : tab.title || hostOf(tab.url) || '新标签页';
      item.title = `${label}\n${tab.url}`;
      const dot = document.createElement('span');
      dot.className = 'tab-dot' + (tab.loading ? ' loading' : tab.busy ? ' busy' : '');
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = label;
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', '关闭标签页');
      close.onclick = (event) => {
        event.stopPropagation();
        send({ t: 'tab.close', id: tab.id });
      };
      item.onclick = () => send({ t: 'tab.select', id: tab.id });
      item.onauxclick = (event) => {
        if (event.button === 1) send({ t: 'tab.close', id: tab.id });
      };
      item.append(dot, title, close);
      return item;
    }));
  }

  function render() {
    const tab = activeTab();
    renderTabs();
    $('back').disabled = !tab || !tab.canBack;
    $('forward').disabled = !tab || !tab.canForward;
    const reload = $('reload');
    reload.textContent = tab && tab.loading ? '✕' : '↻';
    reload.title = tab && tab.loading ? '停止' : '刷新';
    reload.setAttribute('aria-label', reload.title);
    if (document.activeElement !== urlInput) urlInput.value = tab && tab.url !== 'about:blank' ? tab.url : '';
    renderVeil();
    renderModal();
    renderStart();
  }

  $('newTab').onclick = () => send({ t: 'tab.new', url: 'about:blank' });
  $('back').onclick = () => send({ t: 'back' });
  $('forward').onclick = () => send({ t: 'forward' });
  $('reload').onclick = () => send({ t: activeTab() && activeTab().loading ? 'stop' : 'reload' });
  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      send({ t: 'nav', url: urlInput.value });
      ime.focus({ preventScroll: true });
    } else if (event.key === 'Escape') {
      const tab = activeTab();
      urlInput.value = tab ? tab.url : '';
      ime.focus({ preventScroll: true });
    }
  });
  urlInput.addEventListener('focus', () => urlInput.select());

  function openSite(home) {
    if (!home) return;
    const origin = new URL(home).origin;
    const existing = state.tabs.find((tab) => tab.url.startsWith(origin));
    if (existing) send({ t: 'tab.select', id: existing.id });
    else send({ t: 'tab.new', url: home });
  }
  $('external').onclick = async () => {
    const tab = activeTab();
    if (!tab) return;
    const result = await api('/api/open-external', { url: tab.url });
    if (!result.ok) toast(result.error);
  };

  // ---------- 下拉框、对话框、选文件 ----------

  const selectMenu = $('selectMenu');
  function openSelectMenu({ rect, options, selected }) {
    const box = canvas.getBoundingClientRect();
    const scaleX = box.width / (sent.width || box.width);
    const scaleY = box.height / (sent.height || box.height);
    let group = '';
    const items = [];
    for (const option of options) {
      if (option.group && option.group !== group) {
        const head = document.createElement('div');
        head.className = 'group';
        head.textContent = option.group;
        items.push(head);
      }
      group = option.group;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.label;
      button.disabled = option.disabled;
      button.setAttribute('aria-selected', String(option.index === selected));
      button.onclick = () => {
        selectMenu.hidden = true;
        send({ t: 'select.pick', index: option.index });
        ime.focus({ preventScroll: true });
      };
      items.push(button);
    }
    selectMenu.replaceChildren(...items);
    selectMenu.style.minWidth = Math.round(rect.width * scaleX) + 'px';
    selectMenu.style.left = Math.round(rect.x * scaleX) + 'px';
    selectMenu.hidden = false;
    const below = (rect.y + rect.height) * scaleY + 2;
    const fitsBelow = below + selectMenu.offsetHeight <= box.height;
    selectMenu.style.top = Math.round(fitsBelow ? below : Math.max(0, rect.y * scaleY - selectMenu.offsetHeight - 2)) + 'px';
  }
  function closeSelectMenu() {
    if (selectMenu.hidden) return;
    selectMenu.hidden = true;
    send({ t: 'select.pick', index: -1 });
  }

  let modalKey = '';
  function renderModal() {
    const tab = activeTab();
    const dialog = tab && tab.dialog;
    const chooser = tab && tab.fileChooser;
    const key = dialog ? `d|${tab.id}|${dialog.type}|${dialog.message}` : chooser ? `f|${tab.id}` : '';
    if (key === modalKey) return;
    modalKey = key;
    const modal = $('modal');
    const input = $('modalInput');
    if (!key) {
      modal.hidden = true;
      return;
    }
    input.hidden = true;
    input.value = '';
    $('modalCancel').hidden = false;
    $('modalCancel').textContent = '取消';
    $('modalOk').textContent = '确定';
    if (dialog) {
      if (dialog.type === 'beforeunload') {
        $('modalText').textContent = '离开这个页面？没保存的内容会丢。';
        $('modalCancel').textContent = '留下';
        $('modalOk').textContent = '离开';
      } else {
        $('modalText').textContent = dialog.message;
        $('modalCancel').hidden = dialog.type === 'alert';
        if (dialog.type === 'prompt') {
          input.hidden = false;
          input.value = dialog.defaultPrompt;
        }
      }
    } else {
      $('modalText').textContent = chooser.multiple ? '页面要选文件。填文件的完整路径，一行一个。' : '页面要选文件。填文件的完整路径。';
      input.hidden = false;
    }
    modal.hidden = false;
    (input.hidden ? $('modalOk') : input).focus();
  }
  function answerModal(accept) {
    const tab = activeTab();
    if (tab && tab.dialog) {
      send({ t: 'dialog', accept, text: $('modalInput').value });
    } else if (tab && tab.fileChooser) {
      send({ t: 'files', paths: accept ? $('modalInput').value.split('\n') : [] });
    }
    $('modal').hidden = true;
    ime.focus({ preventScroll: true });
  }
  $('modalForm').onsubmit = (event) => {
    event.preventDefault();
    answerModal(true);
  };
  $('modalCancel').onclick = () => answerModal(false);

  let toastTimer = 0;
  function toast(text) {
    const box = $('toast');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
  }

  // ---------- 新标签页 ----------
  //
  // 标签页停在空白页时，面板在画面上盖一层自己画的页：常去的站、最近看过的页。
  // 浏览器里那一页仍然是真的空白页，agent 看到的也是空白页。

  const GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9s1.3-6.3 3.8-9z"/></svg>';
  function siteIcon(icon) {
    const holder = document.createElement('template');
    holder.innerHTML = GLOBE;
    const globe = holder.content.firstChild;
    if (!icon) return globe;
    const image = document.createElement('img');
    image.alt = '';
    image.src = icon;
    image.onerror = () => image.replaceWith(globe);
    return image;
  }

  function whenText(time, timeZone) {
    const options = timeZone ? { timeZone } : {};
    const day = new Intl.DateTimeFormat('zh-CN', { ...options, year: 'numeric', month: 'numeric', day: 'numeric' });
    if (day.format(time) === day.format(Date.now())) {
      return new Intl.DateTimeFormat('zh-CN', { ...options, hour: '2-digit', minute: '2-digit', hour12: false }).format(time);
    }
    return new Intl.DateTimeFormat('zh-CN', { ...options, month: 'numeric', day: 'numeric' }).format(time);
  }

  function fillStart(data) {
    const go = (url) => () => send({ t: 'nav', url });
    $('startTiles').replaceChildren(...data.sites.map((site) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.title = site.url;
      const label = document.createElement('span');
      label.textContent = site.title || site.host;
      tile.append(siteIcon(site.icon), label);
      tile.onclick = go(site.url);
      return tile;
    }));
    $('startList').replaceChildren(...data.recent.map((page) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'recent-row';
      row.title = page.url;
      const title = document.createElement('span');
      title.className = 'recent-title';
      title.textContent = page.title || page.host;
      const host = document.createElement('span');
      host.className = 'recent-host';
      host.textContent = page.host;
      const when = document.createElement('span');
      when.className = 'recent-when';
      when.textContent = whenText(page.last, data.timeZone);
      row.append(siteIcon(page.icon), title, host, when);
      row.onclick = go(page.url);
      return row;
    }));
    $('startSites').hidden = !data.sites.length;
    $('startRecent').hidden = !data.recent.length;
    $('startHint').hidden = data.sites.length > 0 || data.recent.length > 0;
  }

  async function loadStart() {
    const data = await api('/api/start');
    if (data.ok) fillStart(data);
  }

  let startFor = '';
  function renderStart() {
    const tab = activeTab();
    const showFor = state.running && tab && tab.url === 'about:blank' && !tab.crashed ? tab.id : '';
    $('start').hidden = !showFor;
    if (showFor === startFor) return;
    startFor = showFor;
    if (!showFor) return;
    loadStart();
    if ($('modal').hidden) urlInput.focus();
  }
  $('startClear').onclick = async () => {
    await api('/api/history-clear');
    loadStart();
  };

  // ---------- 给附加功能用的接口 ----------
  //
  // 后台的 extensions/ 里有附加功能时，它的脚本排在这个文件后面加载，通过这个对象往面板上加东西。
  window.workbenchBrowser = {
    api,
    send,
    toast,
    copyLocal,
    openSite,
    // 地址栏右边加一个文字按钮。
    addButton(label, onClick) {
      const button = document.createElement('button');
      button.className = 'text';
      button.type = 'button';
      button.textContent = label;
      button.onclick = () => onClick(button);
      $('external').before(button);
      return button;
    },
    // 画面右边加一栏。
    addSidePanel(element) {
      $('stage').append(element);
    },
    // 后台广播的消息里，主体不认识的类型交给附加功能。
    on(type, handler) {
      listeners.set(type, [...(listeners.get(type) || []), handler]);
    },
  };

  render();
  connect();
})();

// A small helper injected into an isolated world of every page: the page's own scripts cannot see it,
// and it does not change the page. It does only the two things a headless browser cannot do by itself:
//   1. The popup list of a native dropdown (<select>) never shows up in the picture, so the options are
//      reported to the panel, which draws the list;
//   2. The mouse cursor is not part of the picture, so its shape is reported to the panel, which follows it.
export const HELPER_WORLD = 'workbench_browser_helper';
export const HELPER_BINDING = '__workbenchBrowserHost';

export const HELPER_SOURCE = `(() => {
  if (globalThis.__workbenchBrowserInstalled) return;
  globalThis.__workbenchBrowserInstalled = true;
  const report = (message) => {
    try { ${HELPER_BINDING}(JSON.stringify(message)); } catch (error) { /* the channel is not connected yet; drop this one */ }
  };

  // Title: the debug channel reports it only once, when the address changes (it is still a placeholder then),
  // and says nothing when the page changes its title later, so watch it here.
  if (window === window.top) {
    let lastTitle = null;
    let titleTimer = 0;
    const reportTitle = () => {
      titleTimer = 0;
      if (document.title === lastTitle) return;
      lastTitle = document.title;
      report({ type: 'title', title: lastTitle });
    };
    const scheduleTitle = () => {
      if (!titleTimer) titleTimer = setTimeout(reportTitle, 120);
    };
    new MutationObserver(scheduleTitle).observe(document, { subtree: true, childList: true, characterData: true });
    addEventListener('DOMContentLoaded', scheduleTitle);
    addEventListener('load', scheduleTitle);
    scheduleTitle();
  }

  let openSelect = null;
  if (window === window.top) {
    addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const target = event.target;
      const select = target && target.closest ? target.closest('select') : null;
      if (!select || select.disabled || select.multiple || select.size > 1) return;
      event.preventDefault();
      select.focus();
      openSelect = select;
      const box = select.getBoundingClientRect();
      report({
        type: 'select',
        rect: { x: box.left, y: box.top, width: box.width, height: box.height },
        selected: select.selectedIndex,
        options: Array.from(select.options, (option, index) => ({
          index,
          label: option.label || option.text,
          disabled: option.disabled || (option.parentElement && option.parentElement.disabled) || false,
          group: option.parentElement && option.parentElement.tagName === 'OPTGROUP' ? option.parentElement.label : '',
        })),
      });
    }, true);
  }
  globalThis.__workbenchBrowserPick = (index) => {
    const select = openSelect;
    openSelect = null;
    if (!select || index < 0 || index >= select.options.length || select.selectedIndex === index) return false;
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  let lastCursor = '';
  let pending = 0;
  let pointerX = 0;
  let pointerY = 0;
  const editable = (element) => !!element && (element.isContentEditable || /^(INPUT|TEXTAREA)$/.test(element.tagName));
  addEventListener('mousemove', (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (pending) return;
    pending = setTimeout(() => {
      pending = 0;
      const element = document.elementFromPoint(pointerX, pointerY);
      let cursor = element ? getComputedStyle(element).cursor : 'default';
      if (cursor === 'auto') cursor = editable(element) ? 'text' : 'default';
      if (cursor !== lastCursor) {
        lastCursor = cursor;
        report({ type: 'cursor', cursor });
      }
    }, 60);
  }, true);
})();`;

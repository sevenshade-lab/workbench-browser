// 注入到每个页面「隔离环境」里的小帮手：页面自己的脚本看不到它，它也不改页面内容。
// 只做两件无界面浏览器做不了的事：
//   1. 原生下拉框（<select>）的弹出列表不会出现在画面里，改成把选项报给面板，由面板画一个列表；
//   2. 鼠标指针的样子不在画面里，报给面板让它跟着变。
export const HELPER_WORLD = 'workbench_browser_helper';
export const HELPER_BINDING = '__workbenchBrowserHost';

export const HELPER_SOURCE = `(() => {
  if (globalThis.__workbenchBrowserInstalled) return;
  globalThis.__workbenchBrowserInstalled = true;
  const report = (message) => {
    try { ${HELPER_BINDING}(JSON.stringify(message)); } catch (error) { /* 通道还没接上，丢掉这一条 */ }
  };

  // 标题：调试通道只在换地址时报一次（那时还是占位标题），之后页面改标题不通知，所以自己盯着。
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

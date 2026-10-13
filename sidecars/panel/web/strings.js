// Every piece of text in the panel, in Chinese and in English.
//
// index.html names the keys in attributes such as data-t; app.js fetches them with t('key').
// To add a sentence, add an entry here, in both languages; tests/smoke.mjs checks that every key in use exists.
window.workbenchStrings = {
  appName: { zh: '工作台浏览器', en: 'Workbench Browser' },

  // Tabs and the address bar
  newTab: { zh: '新标签页', en: 'New tab' },
  closeTab: { zh: '关闭标签页', en: 'Close tab' },
  back: { zh: '后退', en: 'Back' },
  forward: { zh: '前进', en: 'Forward' },
  reload: { zh: '刷新', en: 'Reload' },
  stop: { zh: '停止', en: 'Stop' },
  address: { zh: '地址', en: 'Address' },
  addressHint: { zh: '输入网址，或者要搜的内容', en: 'Enter an address or search' },
  openExternal: { zh: '在系统浏览器打开', en: 'Open in your default browser' },
  pageView: { zh: '网页画面', en: 'Page view' },
  pageInput: { zh: '网页输入', en: 'Page input' },

  // New-tab page
  frequent: { zh: '常去', en: 'Most visited' },
  recent: { zh: '最近', en: 'Recent' },
  clearHistory: { zh: '清空记录', en: 'Clear history' },
  startHint: {
    zh: '在上面的地址栏输入网址，或者直接输入要搜的内容',
    en: 'Type an address in the bar above, or just type what you want to search for',
  },

  // States shown over the picture
  connecting: { zh: '正在连接插件后台', en: 'Connecting to the plugin backend…' },
  unreachable: {
    zh: '连不上插件后台。插件可能刚重启过：请关掉这个面板再重新打开',
    en: 'Cannot reach the plugin backend. The plugin may have just restarted: close this panel and open it again.',
  },
  reconnecting: { zh: '连接断开，正在重连', en: 'Connection lost. Reconnecting…' },
  starting: { zh: '正在启动浏览器', en: 'Starting the browser…' },
  crashed: { zh: '这个页面崩溃了', en: 'This page crashed' },
  retry: { zh: '重试', en: 'Retry' },

  // Dialogs
  ok: { zh: '确定', en: 'OK' },
  cancel: { zh: '取消', en: 'Cancel' },
  leavePage: { zh: '离开这个页面？没保存的内容会丢。', en: 'Leave this page? Changes you have not saved will be lost.' },
  stay: { zh: '留下', en: 'Stay' },
  leave: { zh: '离开', en: 'Leave' },
  chooseFile: { zh: '页面要选文件。填文件的完整路径。', en: 'This page is asking for a file. Enter its full path.' },
  chooseFiles: {
    zh: '页面要选文件。填文件的完整路径，一行一个。',
    en: 'This page is asking for files. Enter the full path of each file, one per line.',
  },

  // Notices
  noResponse: { zh: '插件后台没有响应', en: 'The plugin backend is not responding' },
  copyFailed: { zh: '复制失败', en: 'Copy failed' },
};

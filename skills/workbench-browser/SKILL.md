---
name: workbench-browser
description: >-
  用侧边栏的「工作台浏览器」看网页、操作网页：任何 http/https 页面，包括本机起的开发服务。
  用户说「在内置浏览器里打开/看看/点一下/填一下」，或者需要你和他看着同一个页面干活时使用。
---

# 工作台浏览器

侧边栏里是一个真浏览器（有自己的登录状态，和用户平时用的 Chrome 分开）。
**你操作的和用户在侧边栏里看到的是同一批页面**，你每一步他都看得见。

## 怎么用

- **让用户看到面板**：回复里放这个链接，他点一下就打开：`[工作台浏览器](sidecar://workbench-browser/panel/)`。
  你没法替他打开侧边栏，这是 Antigravity 的规矩。
- **你自己操作页面**：用本插件带的浏览器工具（`list_pages`、`navigate_page`、`take_snapshot`、`click`、
  `fill`、`type_text`、`press_key`、`wait_for`、`take_screenshot`、`evaluate_script` 等）。
  流程固定是：`take_snapshot` 读页面结构拿到元素的 `uid` → 用 `uid` 去点、去填 → 再 `take_snapshot` 看结果。
  页面变了 `uid` 就失效，重新读。浏览器没开时第一次调用会自动启动，不用管。
- **看浏览器开没开、开着哪些页**：`wb.mjs` 在插件目录的 `tools` 下，
  Windows 上是 `%USERPROFILE%\.gemini\config\plugins\workbench-browser\tools\wb.mjs`：

  ```
  node <那个路径> status        浏览器开没开、开着哪些页
  node <那个路径> open <网址>    在当前标签页打开网址
  ```

## 必须守的

1. **做完要读回来核对。** 点了「保存」「提交」「发布」不等于成功。操作之后重新读页面，
   用页面上实际看到的结果汇报；没读到就说「没能确认」，不要写「已成功」。
2. **登录、扫码、短信验证码、滑块验证，只能用户自己来。** 遇到登录页或验证，停下来，给出面板链接，
   请用户在面板里完成。不要代填账号密码，不要想办法绕过验证。
3. **有后果的选项是用户的决定。** 付款、发布、删除、授权这类弹窗里的选项，按用户这一次明确说的做；
   他没说，就停下来问，不要自己默认。

## 出问题时

- 工具报「插件没在运行」：请用户到 Customizations → Installed 确认 `workbench-browser` 已启用。
- 面板空白或一直「正在启动浏览器」：看日志
  `~/.gemini/antigravity/sidecar_data/workbench-browser/panel/logs/sidecar.log`。

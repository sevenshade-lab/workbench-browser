---
name: workbench-browser
description: >-
  View and operate web pages in the Workbench Browser side panel (工作台浏览器): any http/https page, including
  dev servers running on this machine. Use it when the user asks to open, look at, click or fill in something
  "in the built-in browser" (在内置浏览器里打开 / 看看 / 点一下 / 填一下), or when you and the user need to
  work on the same page together.
---

# Workbench Browser

The side panel holds a real browser. It has its own logins, separate from the Chrome the user normally uses.
**The pages you operate are the very pages the user sees in the side panel**, and they can watch every step you take.

Talk to the user in their own language. This file is in English only so that anyone can read it.

## How to use it

- **Show the panel to the user**: put this link in your reply and they open it with one click:
  `[Workbench Browser](sidecar://workbench-browser/panel/)`. Write the link text in the user's language
  (in Chinese: 工作台浏览器). You cannot open the side panel for them; that is an Antigravity rule.
- **Operate pages yourself**: use the browser tools that come with this plugin (`list_pages`, `navigate_page`,
  `take_snapshot`, `click`, `fill`, `type_text`, `press_key`, `wait_for`, `take_screenshot`, `evaluate_script` and so on).
  The sequence is always the same: `take_snapshot` to read the page structure and get the `uid` of each element →
  click or fill by `uid` → `take_snapshot` again to see the result. When the page changes, the `uid`s expire: read again.
  If the browser is not running, the first tool call starts it; you do not need to do anything.
- **See whether the browser is running and which pages are open**: `wb.mjs` is in the `tools` folder of the plugin.
  On Windows that is `%USERPROFILE%\.gemini\config\plugins\workbench-browser\tools\wb.mjs`:

  ```
  node <that path> status        is the browser running, which pages are open
  node <that path> open <url>    open an address in the current tab
  ```

## Rules you must keep

1. **Read the page back after you act.** Clicking Save, Submit or Publish is not success. After the action, read the
   page again and report what the page actually shows. If you could not read it, say you could not confirm it;
   do not write that it succeeded.
2. **Logins, QR codes, SMS codes and slider or CAPTCHA checks are for the user only.** When you reach a login page
   or a verification step, stop, give the panel link, and ask the user to finish it in the panel. Do not type
   account names or passwords for them, and do not look for a way around the verification.
3. **Choices with consequences belong to the user.** For the options in a payment, publish, delete or authorize
   dialog, do what the user explicitly said this time. If they did not say, stop and ask; do not pick a default yourself.

## When something goes wrong

- A tool reports that the plugin is not running (in Chinese: 插件没在运行): ask the user to check under
  Customizations → Installed that `workbench-browser` is enabled.
- The panel is blank or stays on "Starting the browser…" (in Chinese: 正在启动浏览器): read the log at
  `~/.gemini/antigravity/sidecar_data/workbench-browser/panel/logs/sidecar.log`. The log lines are in Chinese.

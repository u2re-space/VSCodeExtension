export function agentHtml({ cssHref, scriptHref, nonce, cspSource }) {
    const csp = [
        "default-src 'none'",
        `img-src ${cspSource} data:`,
        `style-src ${cspSource} 'nonce-${nonce}'`,
        `font-src ${cspSource}`,
        `script-src ${cspSource} 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssHref}" />
  <style nonce="${nonce}">
    body.agent-body { block-size: 100dvh; overflow: hidden; }
    body.agent-body .agent-shell, body.agent-body textarea, body.agent-body .agent-log { user-select: text; }
    .agent-shell { display: flex; flex-direction: column; gap: 8px; block-size: 100dvh; padding: 8px; }
    .agent-log { flex: 1; overflow: auto; white-space: pre-wrap; border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
    .agent-log .warn, .agent-log .fail { color: var(--button-active); }
    #prompt { inline-size: 100%; min-block-size: 4.5rem; resize: vertical; }
    .agent-actions, .agent-approval { display: flex; flex-wrap: wrap; gap: 6px; }
    .agent-actions button, .agent-approval button, #reconnect, #stop {
      border: 1px solid var(--border); background: var(--button-bg); color: var(--foreground); border-radius: 8px; padding: 4px 8px;
    }
  </style>
</head>
<body class="agent-body" data-theme="dark">
  <div class="agent-shell">
    <div class="toolbar">
      <span id="status" class="toolbar-label">агент не запущен</span>
      <button id="reconnect" type="button">Переподключить</button>
      <button id="stop" type="button" hidden>Остановить</button>
    </div>
    <div id="log" class="agent-log" aria-live="polite"></div>
    <div id="approval" class="agent-approval" hidden></div>
    <form id="composer">
      <textarea id="prompt" placeholder="Команда агенту"></textarea>
      <div class="agent-actions">
        <button type="submit" data-command="run">Run</button>
        <button type="submit" data-command="ask">Ask</button>
        <details>
          <summary>Ещё</summary>
          <button type="submit" data-command="chat">Chat</button>
          <button type="submit" data-command="image">Image</button>
        </details>
      </div>
    </form>
  </div>
  <script nonce="${nonce}" type="module" src="${scriptHref}"></script>
</body>
</html>`;
}

const icon = (id, label) => (
    `<svg class="ph-icon" viewBox="0 0 256 256" aria-hidden="true"><use href="#ph-${id}"></use></svg>`
    + (label ? `<span class="agent-sr">${label}</span>` : '')
);

const SPRITE = `<span class="ph-sprite" aria-hidden="true"><svg class="ph-sprite-svg" aria-hidden="true" focusable="false" width="0" height="0"><defs>
  <symbol id="ph-arrow-clockwise" viewBox="0 0 256 256"><path d="M224 48v56h-56M198 104a88 88 0 1 0-8 96" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path></symbol>
  <symbol id="ph-stop-circle" viewBox="0 0 256 256"><circle cx="128" cy="128" r="96" fill="none" stroke="currentColor" stroke-width="16"></circle><rect x="108" y="108" width="40" height="40" fill="none" stroke="currentColor" stroke-width="16"></rect></symbol>
  <symbol id="ph-x" viewBox="0 0 256 256"><path d="m200 56-144 144M56 56l144 144" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"></path></symbol>
  <symbol id="ph-rocket-launch" viewBox="0 0 256 256"><path fill="currentColor" d="M223.85,47.12a16,16,0,0,0-15-15c-12.58-.75-44.73.4-71.41,27.07L132.69,64H74.36A15.91,15.91,0,0,0,63,68.68L28.7,103a16,16,0,0,0,9.07,27.16l38.47,5.37,44.21,44.21,5.37,38.49a15.94,15.94,0,0,0,10.78,12.92,16.11,16.11,0,0,0,5.1.83A15.91,15.91,0,0,0,153,227.3L187.32,193A15.91,15.91,0,0,0,192,181.64V123.31l4.77-4.77C223.45,91.86,224.6,59.71,223.85,47.12ZM74.36,80h42.33L77.16,119.52,40,114.34Zm74.41-9.45a76.65,76.65,0,0,1,59.11-22.47,76.46,76.46,0,0,1-22.42,59.16L128,164.68,91.32,128ZM176,181.64,141.67,216l-5.19-37.17L176,139.31Zm-74.16,9.5C97.34,201,82.29,224,40,224a8,8,0,0,1-8-8c0-42.29,23-57.34,32.86-61.85a8,8,0,0,1,6.64,14.56c-6.43,2.93-20.62,12.36-23.12,38.91,26.55-2.5,36-16.69,38.91-23.12a8,8,0,1,1,14.56,6.64Z"></path></symbol>
  <symbol id="ph-chat-circle" viewBox="0 0 256 256"><path d="M128 32a96 96 0 0 0-84 141l-12 43 45-14A96 96 0 1 0 128 32Z" fill="none" stroke="currentColor" stroke-width="16" stroke-linejoin="round"></path></symbol>
  <symbol id="ph-chats" viewBox="0 0 256 256"><path d="M96 112a64 64 0 1 1 64 64H88l-24 16 8-28A64 64 0 0 1 96 112Z" fill="none" stroke="currentColor" stroke-width="16"></path><path d="M168 48a64 64 0 0 1 48 80l8 28-24-16" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
  <symbol id="ph-image" viewBox="0 0 256 256"><rect x="32" y="48" width="192" height="160" rx="16" fill="none" stroke="currentColor" stroke-width="16"></rect><circle cx="92" cy="100" r="12" fill="currentColor"></circle><path d="m48 168 48-40 40 32 32-24 40 32" fill="none" stroke="currentColor" stroke-width="16" stroke-linejoin="round"></path></symbol>
  <symbol id="ph-dots-three" viewBox="0 0 256 256"><circle cx="60" cy="128" r="14" fill="currentColor"></circle><circle cx="128" cy="128" r="14" fill="currentColor"></circle><circle cx="196" cy="128" r="14" fill="currentColor"></circle></symbol>
  <symbol id="ph-check" viewBox="0 0 256 256"><path d="m40 136 56 56L216 72" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"></path></symbol>
  <symbol id="ph-shield-check" viewBox="0 0 256 256"><path d="M128 24 48 56v64c0 56 40 94 80 112 40-18 80-56 80-112V56Z" fill="none" stroke="currentColor" stroke-width="16"></path><path d="m92 128 20 20 52-52" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round"></path></symbol>
  <symbol id="ph-paper-plane-tilt" viewBox="0 0 256 256"><path d="m216 40-176 72 64 24 24 64Z" fill="none" stroke="currentColor" stroke-width="16" stroke-linejoin="round"></path><path d="m104 136 112-96" fill="none" stroke="currentColor" stroke-width="16"></path></symbol>
</defs></svg></span>`;

export function agentHtml({ cssHref, scriptHref, nonce, cspSource, theme = 'dark' }) {
    const safeTheme = theme === 'light' || theme === 'oled' ? theme : 'dark';
    const csp = [
        "default-src 'none'",
        `img-src ${cspSource} data:`,
        `style-src ${cspSource} 'nonce-${nonce}'`,
        `font-src ${cspSource}`,
        `script-src ${cspSource} 'nonce-${nonce}'`,
    ].join('; ');
    return `<!doctype html>
<html data-theme="${safeTheme}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssHref}" />
  <style nonce="${nonce}">
    body.agent-body { block-size: 100dvh; overflow: hidden; box-sizing: border-box; background: var(--background); color: var(--foreground); }
    .agent-note { font-size: 0.75rem; opacity: 0.85; white-space: pre-wrap; }
    body.agent-body .agent-shell, body.agent-body textarea, body.agent-body .agent-log, body.agent-body input { user-select: text; }
    .agent-shell { display: flex; flex-direction: column; gap: 0.35rem; flex: 1 1 auto; min-block-size: 0; block-size: auto; }
    .agent-shell .toolbar { display: flex; grid-template-columns: none; }
    .agent-shell .toolbar-label { grid-column: auto; flex: 1 1 auto; font-size: 0.75rem; font-weight: 600; opacity: 0.85; }
    .agent-log {
      flex: 1 1 auto; min-block-size: 0; overflow: auto; white-space: pre-wrap;
      border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.5rem;
      background: var(--highlight); color: var(--foreground);
    }
    .agent-log .ok { color: var(--button-active); }
    .agent-log .action { color: var(--foreground); }
    .agent-log .info { opacity: 0.72; }
    .agent-log .warn, .agent-log .fail { color: color-mix(in srgb, var(--foreground) 55%, #ff5a5a 45%); }
    #prompt {
      inline-size: 100%; min-block-size: 4.5rem; resize: vertical;
      background: var(--button-bg); color: var(--foreground);
      border: 1px solid var(--border); border-radius: 0.5rem;
      font: inherit; padding: 0.5rem;
    }
    #approvalInput {
      inline-size: 100%; min-block-size: 2rem; resize: none;
      background: var(--button-bg); color: var(--foreground);
      border: 1px solid var(--border); border-radius: 0.5rem;
      font: inherit; padding: 0.45rem 0.5rem;
    }
    .agent-sr { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .agent-composer { display: flex; flex-direction: column; gap: 0.35rem; }
    .agent-composer .actions-container { align-self: flex-end; }
  </style>
</head>
<body class="agent-body" data-theme="${safeTheme}">
  ${SPRITE}
  <div class="agent-shell manager-root">
    <div class="toolbar">
      <span id="status" class="toolbar-label" title="агент не запущен">агент не запущен</span>
      <div class="actions-container">
        <button id="reconnect" type="button" title="Переподключить" aria-label="Переподключить">${icon('arrow-clockwise')}</button>
        <button id="stop" class="danger" type="button" title="Остановить" aria-label="Остановить" hidden>${icon('stop-circle')}</button>
        <button id="cancel" type="button" title="Отмена" aria-label="Отмена">${icon('x')}</button>
      </div>
    </div>
    <div id="log" class="agent-log" aria-live="polite"></div>
    <div id="approval" hidden>
      <div id="approvalText" class="agent-note"></div>
      <input id="approvalInput" type="text" hidden>
      <div id="approvalActions" class="actions-container"></div>
    </div>
    <form id="composer" class="agent-composer">
      <textarea id="prompt" placeholder="Команда агенту"></textarea>
      <div class="actions-container">
        <button type="submit" data-command="run" title="Run" aria-label="Run">${icon('rocket-launch', 'Run')}</button>
        <button type="submit" data-command="ask" title="Ask" aria-label="Ask">${icon('chat-circle', 'Ask')}</button>
        <details class="more-menu">
          <summary title="Ещё" aria-label="Ещё">${icon('dots-three')}</summary>
          <div class="more-menu-list">
            <button type="submit" data-command="chat" title="Chat" aria-label="Chat">${icon('chats')}</button>
            <button type="submit" data-command="image" title="Image" aria-label="Image">${icon('image')}</button>
          </div>
        </details>
      </div>
    </form>
  </div>
  <script nonce="${nonce}" type="module" src="${scriptHref}"></script>
</body>
</html>`;
}

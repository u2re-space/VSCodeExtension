export const defaultCSS = `
* {
    box-sizing: border-box;
}

:root {
    /* VS Code dark theme colors */
    --highlight: color(srgb 1 1 1 / 0.01);
    --background: #1e1e1e;
    --foreground: #d4d4d4;
    --border: #333;
    --button-bg: #2d2d2d;
    --button-hover: #3c3c3c;
    --button-active: #007acc;
    --button-fg: #d4d4d4;
    --button-shadow: 0 2px 8px rgba(0,0,0,0.2);
    --row-hover: color(srgb 1 1 1 / 0.02);
    --scrollbar-bg: #23272e;
    --scrollbar-thumb: color(srgb 1 1 1 / 0.5);
    --scrollbar-thumb-hover: color(srgb 1 1 1 / 0.6);
}

html {
    padding: 0px;
    margin: 0px;
}

body {
    background: var(--background);
    color: var(--foreground);
    font-family: "Segoe UI", "Fira Code", "Consolas", monospace;
    margin: 0;
    padding: 0.5em 1em;
    block-size: min(100svh, 100cqh);
    min-block-size: min(100svh, 100cqh);
    max-block-size: min(100svh, 100cqh);
    overflow: hidden;
    box-sizing: border-box;
    container-type: size;
    position: fixed;
    inline-size: 100%;
}

table {
    inline-size: 100%;
    border-radius: 0.5rem;
    border-collapse: collapse;
    clip-path: inset(0 round 0.5rem);
    margin-block-start: 3rem;
    margin-block-end: 0rem;
    overflow-y: auto;
    overflow-x: hidden;

    background: var(--highlight);
    block-size: max-content;
    max-block-size: stretch;
    max-block-size: -webkit-fill-available;

    display: flex;
    flex-direction: column;
    box-sizing: border-box;

    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb) transparent;/*var(--scrollbar-bg)*/;
    scrollbar-gutter: auto;
}

tr {
    transition: background 0.2s;
    max-block-size: max-content;
    block-size: max-content;
    overflow: hidden;
    display: flex;
    flex-direction: row;
    flex-grow: 1;
    flex-shrink: 0;
    flex-basis: stretch;
    inline-size: 100%;
    place-content: center;
    place-items: center;
    padding-inline: 0.5rem;
    box-sizing: border-box;
}

tr:hover { background: var(--row-hover); }

td {
    padding: 0px;
    padding-block: 0.5rem;
    vertical-align: middle;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    flex-direction: row;
    flex-shrink: 0;
    flex-grow: 1;
    flex-basis: stretch;
    text-align: start;
    max-block-size: max-content;
    block-size: max-content;
    box-sizing: border-box;
}

button {
    overflow: hidden;
    background: var(--button-bg);
    color: var(--button-fg);
    border: none;
    border-radius: 6px;
    margin: 0 0.15em;
    padding: 0.5rem;
    font-size: 1em;
    font-family: inherit;
    cursor: pointer;
    /*box-shadow: var(--button-shadow);*/
    transition: background 0.15s, color 0.15s, box-shadow 0.15s;
    outline: none;
    position: relative;
    aspect-ratio: 1 / 1;
    inline-size: 2rem;
    block-size: 2rem;
    display: inline flex;
    place-content: center;
    place-items: center;
}

button:hover {
    background: var(--button-hover);
    color: #fff;
}

button:active {
    background: var(--button-active);
    color: #fff;
}

button:focus {
    /*box-shadow: 0 0 0 2px #007acc55;*/
}

@media (prefers-color-scheme: light) {
    :root {
        --highlight: color(srgb 0 0 0 / 0.01);
        --background: #f3f3f3;
        --foreground: #222;
        --border: #e1e1e1;
        --button-bg: #e7e7e7;
        --button-hover: #d0d0d0;
        --button-active: #007acc;
        --button-fg: #222;
        --button-shadow: 0 2px 8px rgba(0,0,0,0.07);
        --row-hover: color(srgb 0 0 0 / 0.02);
        --scrollbar-bg: #f0f0f0;
        --scrollbar-thumb: color(srgb 0 0 0 / 0.5);
        --scrollbar-thumb-hover: color(srgb 0 0 0 / 0.6);
    }
}

.toolbar {
    place-content: center; place-items: center;
    padding: 0.25rem 1rem 0.25rem 1rem;
    display: flex; gap: 0.125rem;
    padding-inline-end: 0.5rem;
    background: var(--background);
    border-radius: 0.5rem;
    inset-inline-start: 0px;
    inset-block-start: 0px;
    position: fixed;
    z-index: 2;
    flex-directon: row;
    text-align: start;
    justify-content: start;
    margin-block-start: 0.5rem;
    margin-block-end: 0.5rem;
    margin-inline: 0.75rem;
    block-size: max-content;
    min-block-size: 2rem;
    inline-size: calc(100% - 1.5rem);
}

.toolbar-label {
    font-weight: bold;
    font-size: 1.1em;
    block-size: max-content;
}

:where(.toolbar, tr):has(button:focus) {
    border-bottom: 2px solid var(--button-active);
}

button:focus {
    outline: 2px solid var(--button-active);
    outline-offset: 1px;
}
`;

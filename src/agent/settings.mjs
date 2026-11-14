const APPROVE = new Set(['ask', 'read', 'write', 'all']);

const RECONNECT_SECTIONS = [
    'vext.agent.port',
    'vext.agent.token',
    'vext.agent.openaiBaseUrl',
    'vext.agent.openaiApiKey',
    'vext.agent.launch',
    'vext.agent.command',
    'vext.agent.server',
];

export function shouldReconnectAgent(affectsConfiguration) {
    return RECONNECT_SECTIONS.some((section) => affectsConfiguration(section));
}

/**
 * The servers the extension knows.
 *
 * `ai-serve` is the package `@u2ai/server`, `ai` is the monolith. Both take the same
 * subcommand `serve`, so the difference is the name of the program.
 */
const SERVERS = new Set(['ai-serve', 'ai']);

/** The program of every server. */
const SERVER_PROGRAMS = Object.freeze({
    'ai-serve': 'ai-serve',
    ai: 'ai',
});

/**
 * The models of the servers.
 *
 * The first three are the models of the package `@u2ai/server`: the default one and the
 * chain of the fallback. The other ones belong to the monolith.
 */
const COMPLETION_MODELS = new Set([
    'minimax/minimax-m3.1-flash',
    'moonshotai/kimi-k3',
    'openai/gpt-5.1',
    'gpt-6-luna',
    'anthropic/claude-haiku-5-5',
    'qwen/qwen3.8-omni-flash',
    'qwen/qwen3.8-flash',
    'z-ai/glm-5.3-flash',
    'x-ai/grok-4.7',
    'gemini-3.8-flash',
    'deepseek/deepseek-v4.1-flash',
]);

/** The model of the server by default. */
export const DEFAULT_COMPLETION_MODEL = 'minimax/minimax-m3.1-flash';

export function readAgentSettings(get) {
    const portValue = get('vext.agent.port');
    const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65535 ? portValue : 0;
    const debounceValue = get('vext.agent.completion.debounceMs');
    const parsedDebounce = typeof debounceValue === 'number' && Number.isFinite(debounceValue) && debounceValue >= 0 ? debounceValue : 350;
    const debounceMs = Math.max(50, parsedDebounce);
    const approveValue = get('vext.agent.approve');
    const modelValue = get('vext.agent.completion.model');
    const completionModel = COMPLETION_MODELS.has(modelValue) ? modelValue : DEFAULT_COMPLETION_MODEL;
    const serverValue = get('vext.agent.server');
    const commandValue = typeof get('vext.agent.command') === 'string' ? get('vext.agent.command').trim() : '';
    return {
        port,
        token: typeof get('vext.agent.token') === 'string' ? get('vext.agent.token') : '',
        openaiBaseUrl: typeof get('vext.agent.openaiBaseUrl') === 'string' ? get('vext.agent.openaiBaseUrl') : '',
        openaiApiKey: typeof get('vext.agent.openaiApiKey') === 'string' ? get('vext.agent.openaiApiKey') : '',
        launch: get('vext.agent.launch') === true,
        // The program of the server. Empty means the program of the setting `server`.
        command: commandValue,
        // The server to start: the package, the monolith, or the first one that answers.
        server: SERVERS.has(serverValue) ? serverValue : 'auto',
        approve: APPROVE.has(approveValue) ? approveValue : 'ask',
        completionEnabled: get('vext.agent.completion.enabled') !== false,
        debounceMs,
        completionModel,
    };
}

/**
 * The programs to try, in the order of the attempt.
 *
 * The command of the settings wins: a user with a build of their own points the
 * extension at it. Without a command the server decides: the package first, the
 * monolith after.
 *
 * @param {{ server?: string, command?: string }} settings
 * @returns {string[]}
 */
export function serverCommands(settings) {
    const custom = typeof settings?.command === 'string' ? settings.command.trim() : '';
    if (custom) {
        return [custom];
    }
    const server = SERVERS.has(settings?.server) ? settings.server : 'auto';
    if (server === 'ai-serve') {
        return [SERVER_PROGRAMS['ai-serve']];
    }
    if (server === 'ai') {
        return [SERVER_PROGRAMS.ai];
    }
    return [SERVER_PROGRAMS['ai-serve'], SERVER_PROGRAMS.ai];
}

export function spawnArgs(settings) {
    const args = ['serve'];
    if (settings.port > 0) {
        args.push('--port', String(settings.port));
    }
    return args;
}

export function shouldKillSpawnedPid({ ownPid, livePid }) {
    return Number.isInteger(ownPid) && ownPid > 0 && ownPid === livePid;
}

export function launchOutcome({ cancelled, spawnError, found }) {
    if (spawnError) {
        return 'spawn-error';
    }
    if (cancelled) {
        return 'cancelled';
    }
    if (!found) {
        return 'timeout';
    }
    return 'adopt';
}

export function spawnEnv(baseEnv, settings) {
    const env = { ...baseEnv };
    if (settings.openaiBaseUrl) {
        env.OPENAI_BASE_URL = settings.openaiBaseUrl;
    }
    if (settings.openaiApiKey) {
        env.OPENAI_API_KEY = settings.openaiApiKey;
    }
    return env;
}

const APPROVE = new Set(['ask', 'read', 'write', 'all']);

const RECONNECT_SECTIONS = [
    'vext.agent.port',
    'vext.agent.token',
    'vext.agent.openaiBaseUrl',
    'vext.agent.openaiApiKey',
    'vext.agent.launch',
    'vext.agent.command',
];

export function shouldReconnectAgent(affectsConfiguration) {
    return RECONNECT_SECTIONS.some((section) => affectsConfiguration(section));
}

const COMPLETION_MODELS = new Set([
    'gpt-6-luna',
    'anthropic/claude-haiku-5-5',
    'qwen/qwen3.8-omni-flash',
    'qwen/qwen3.8-flash',
    'z-ai/glm-5.3-flash',
    'x-ai/grok-4.7',
    'gemini-3.8-flash',
    'deepseek/deepseek-v4.1-flash',
]);

export function readAgentSettings(get) {
    const portValue = get('vext.agent.port');
    const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65535 ? portValue : 0;
    const debounceValue = get('vext.agent.completion.debounceMs');
    const parsedDebounce = typeof debounceValue === 'number' && Number.isFinite(debounceValue) && debounceValue >= 0 ? debounceValue : 350;
    const debounceMs = Math.max(50, parsedDebounce);
    const approveValue = get('vext.agent.approve');
    const modelValue = get('vext.agent.completion.model');
    const completionModel = COMPLETION_MODELS.has(modelValue) ? modelValue : 'gpt-6-luna';
    return {
        port,
        token: typeof get('vext.agent.token') === 'string' ? get('vext.agent.token') : '',
        openaiBaseUrl: typeof get('vext.agent.openaiBaseUrl') === 'string' ? get('vext.agent.openaiBaseUrl') : '',
        openaiApiKey: typeof get('vext.agent.openaiApiKey') === 'string' ? get('vext.agent.openaiApiKey') : '',
        launch: get('vext.agent.launch') === true,
        command: typeof get('vext.agent.command') === 'string' && get('vext.agent.command').trim() ? get('vext.agent.command').trim() : 'ai',
        approve: APPROVE.has(approveValue) ? approveValue : 'ask',
        completionEnabled: get('vext.agent.completion.enabled') !== false,
        debounceMs,
        completionModel,
    };
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

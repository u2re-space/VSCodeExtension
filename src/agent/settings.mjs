const APPROVE = new Set(['ask', 'read', 'write', 'all']);

export function readAgentSettings(get) {
    const portValue = get('vext.agent.port');
    const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65535 ? portValue : 0;
    const debounceValue = get('vext.agent.completion.debounceMs');
    const parsedDebounce = typeof debounceValue === 'number' && Number.isFinite(debounceValue) && debounceValue >= 0 ? debounceValue : 1000;
    const debounceMs = Math.max(1000, parsedDebounce);
    const approveValue = get('vext.agent.approve');
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

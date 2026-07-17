// tools.js
import Soup from 'gi://Soup';
import GLib from 'gi://GLib';

const URLS = {
    knowledgeDb: 'http://localhost:8001',
    episodicDb: 'http://localhost:8002',
};

function soupPost(url, body) {
    return new Promise((resolve, reject) => {
        const session = new Soup.Session();
        const msg = Soup.Message.new('POST', url);
        msg.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)))
        );
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            } catch (e) { reject(e); }
        });
    });
}

function soupGet(url, params = {}) {
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const fullUrl = query ? `${url}?${query}` : url;
    return new Promise((resolve, reject) => {
        const session = new Soup.Session();
        const msg = Soup.Message.new('GET', fullUrl);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            } catch (e) { reject(e); }
        });
    });
}

function soupPut(url, body) {
    return new Promise((resolve, reject) => {
        const session = new Soup.Session();
        const msg = Soup.Message.new('PUT', url);
        msg.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)))
        );
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            } catch (e) { reject(e); }
        });
    });
}

async function memoryQuery(query) {
    try {
        const data = await soupGet(`${URLS.knowledgeDb}/search_get`, { query, k: 5, min_score: 0.5 });
        if (!data?.results?.length) return 'No relevant information found in memory.';
        return data.results.map(e => e.text ?? e).join('\n');
    } catch (e) { return 'No relevant information found in memory.'; }
}

async function memoryAdd(text, source = 'user') {
    return
    try {
        const dupCheck = await soupGet(`${URLS.knowledgeDb}/search_get`, { query: text, k: 1, min_score: 0.95 });
        if (dupCheck?.results?.length) return JSON.stringify({ status: 'skipped', message: 'Memory already exists.' });
        const data = await soupPost(`${URLS.knowledgeDb}/add_entry`, { text, source });
        return JSON.stringify({ status: data.status, message: data.message });
    } catch (e) { return JSON.stringify({ status: 'error', message: 'Failed to store information.' }); }
}

async function memoryUpdate(query, text) {
    return
    try {
        const data = await soupPut(`${URLS.knowledgeDb}/update_entry`, { query, text });
        return JSON.stringify({ status: data.status, message: data.message });
    } catch (e) { return JSON.stringify({ status: 'error', message: 'Failed to update entry.' }); }
}

async function memoryRemove(query) {
    try {
        const matches = await soupGet(`${URLS.knowledgeDb}/search_get`, { query, k: 5, min_score: 0.8 });
        if (!matches?.results?.length) return JSON.stringify({ status: 'not_found', message: 'No matching memories found.' });
        const texts = matches.results.map(e => e.text);
        const data = await soupPost(`${URLS.knowledgeDb}/remove_many`, { texts });
        return JSON.stringify({ status: data.status, message: data.message });
    } catch (e) { return JSON.stringify({ status: 'error', message: 'Failed to remove entries.' }); }
}

async function episodicQuery(query, k = 5) {
    try {
        const data = await soupPost(`${URLS.episodicDb}/search`, { query, k, min_score: 0.5 });
        if (!data?.results?.length) return 'No relevant episodic memories found.';
        return data.results.map(m =>
            `[${new Date(m.timestamp * 1000).toLocaleDateString()}] ${m.title}: ${m.summary}`
        ).join('\n');
    } catch (e) { return 'No relevant episodic memories found.'; }
}

async function episodicAdd({ title, summary, participants = [], emotions = [], importance = 0.5 }) {
    return
    try {
        const data = await soupPost(`${URLS.episodicDb}/add_memory`, {
            title, summary, participants, emotions, importance, source: 'conversation', duplicate_min_score: 0.92
        });
        return JSON.stringify({ status: data.status, message: data.message });
    } catch (e) { return JSON.stringify({ status: 'error', message: 'Failed to store episodic memory.' }); }
}

async function queryRecentEpisodicMemories(limit = 4, daysBack = 1) {
    try {
        const data = await soupPost(`${URLS.episodicDb}/recent`, {
            limit: Math.min(limit, 10), days_back: daysBack, min_importance: 0.3
        });
        if (!data?.results?.length) return "I don't have any recent memories to share!";
        const memories = data.results.map(m => {
            const date = new Date(m.timestamp * 1000).toLocaleDateString();
            return `📅 ${date}: ${m.summary}`;
        }).join('\n');
        return `Here's what I remember happening recently:\n${memories}`;
    } catch (e) { return "Hmm, I'm having trouble remembering right now~"; }
}

export async function executeTool(name, args) {
    switch (name) {
        case 'query_memory_database': return memoryQuery(args.query ?? '');
        case 'addto_memory_database': return memoryAdd(args.text ?? '', args.source ?? 'user');
        case 'update_memory_database': return memoryUpdate(args.query ?? '', args.text ?? '');
        case 'remove_memory_database': return memoryRemove(args.query ?? '');
        case 'query_episodic_memory': return episodicQuery(args.query ?? '', args.k ?? 5);
        case 'addto_episodic_memory': return episodicAdd({
            title: args.title ?? 'Untitled',
            summary: args.summary ?? '',
            participants: args.participants ?? [],
            emotions: args.emotions ?? [],
            importance: args.importance ?? 0.5,
        });
        case 'query_recent_episodic_memories': return queryRecentEpisodicMemories(args.limit ?? 5, args.days_back ?? 1);
        default: return `Unknown tool: ${name}`;
    }
}
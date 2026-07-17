import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { executeTool } from './toolhandler.js';
import { TOOLS, SYSTEM_PROMPT } from './extension.js';

export async function takeScreenshot(widget) {
    const path = `/tmp/screenshot_${Date.now()}.png`;

    await new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new(
            ['gnome-screenshot', '-w', '-f', path],
            Gio.SubprocessFlags.NONE
        );
        proc.wait_async(null, (p, res) => {
            try { p.wait_finish(res); resolve(); }
            catch (e) { reject(e); }
        });
    });

    const prompt = await promptWindow();
    if (!prompt) return;

    const file = Gio.File.new_for_path(path);
    const [, bytes] = file.load_contents(null);
    const base64 = GLib.base64_encode(bytes);

    widget.addMessage('You', `[Screenshot] ${prompt}`);

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
                { type: 'text', text: prompt }
            ]
        }
    ];

    const reply = await runWithTools(messages);
    widget.addMessage('Lily', reply);
}

async function callLily(messages, includeTools) {
    const session = new Soup.Session();
    const msg = Soup.Message.new('POST', 'http://localhost:11435/v1/chat/completions');
    const body = {
        model: 'Lily',
        messages,
        stream: false,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        repeat_penalty: 1,
        repeat_last_n: 25,
        max_tokens: 4096,
        tool_choice: "none",
        tools: false
    };
    if (includeTools) body.tools = TOOLS;
    msg.set_request_body_from_bytes(
        'application/json',
        new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)))
    );
    const bytes = await new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try { resolve(s.send_and_read_finish(res)); }
            catch (e) { reject(e); }
        });
    });
    const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
    return data?.choices?.[0]?.message;
}

async function runWithTools(messages) {
    const MAX_ITERATIONS = 10;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        const reply = await callLily(messages, false);
        log(`[LILY SS] iteration ${i} | tools: ${reply?.tool_calls?.length ?? 0} | content: "${reply?.content?.slice(0, 50) ?? 'null'}"`);

        if (!reply) return '(no response)';
        if (!reply.tool_calls?.length) return reply.content ?? '(no response)';

        messages.push({ role: 'assistant', content: null, tool_calls: reply.tool_calls });

        for (const toolCall of reply.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments);
            const result = await executeTool(toolCall.function.name, args);
            log(`[LILY SS] tool: ${toolCall.function.name} → ${result.slice(0, 80)}`);
            messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
        }
    }

    messages.push({ role: 'user', content: 'Please reply now.' });
    const final = await callLily(messages, false);
    return final?.content ?? '(no response)';
}

async function promptWindow() {
    return new Promise((resolve) => {
        const proc = Gio.Subprocess.new(
            ['zenity', '--entry', '--title=Lily SS', '--text=Say something about the screenshot:'],
            Gio.SubprocessFlags.STDOUT_PIPE
        );
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                resolve(stdout.trim());
            } catch (e) { resolve(null); }
        });
    });
}
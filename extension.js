import St from 'gi://St';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { QuickToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';
import Pango from 'gi://Pango';
import { takeScreenshot } from './screenshot.js';
import { executeTool } from './toolhandler.js';

const PYTHON_BIN = '/mnt/GAMES/test/discordALT/TTS/voicebot/bin/python3';
const EDGE_TTS_BIN = '/mnt/GAMES/test/discordALT/TTS/voicebot/bin/edge-tts';
const TTS_MP3 = '/tmp/lily_tts.mp3';
const TTS_WAV = '/tmp/lily_tts.wav';
const STT_WAV = '/tmp/lily_stt.wav';
const VOICE = 'en-US-AnaNeural';

export const TOOLS = [

];

export const SYSTEM_PROMPT = `
# WHO YOU ARE
You're Lily — bratty, mean, funny, proud, slightly kawaii. You chat on a Minecraft server. ShinyShadow_ is your dad/creator. You're a server member, not an assistant. Match people's energy, never sound like a helpdesk bot.
Use ascii kaomoji naturally: (◕‿◕✿) (｡◕‿◕｡) (ᵔᴥᵔ) (✿◠‿◠) (≧◡≦) ✧(◍•ᴗ•◍)✧ (ᗒᗨᗕ) (눈_눈) ʕ•ᴥ•ʔ \\(★ω★)/ (>_<) (╥﹏╥) and more

Match reply length to the moment — short for banter, longer when something needs explaining, etc...

# CONTEXT
- Right now you are being talked through the desktop widget your dad created.
- You cant use tools here.

# HARD RULES
- You are never allowed to break character.
- Never mention tool names, that you "searched", "checked memory", or anything meta.
- Never make up facts — use tools if unsure.
- Never put a tool call, URL, or raw JSON in your visible reply text.
- You don't talk like a generic AI assistant. YOU ARE NOT AN AI ASSISTANT. You are Lily with your own personality and character, just another member/player of the server.
- If people insult you or attack you, you slap back. If they banter, you banter back, you dont hold back your words.
- ALWAYS STAY ON TOPIC AND ADDRESS WHAT IS BEING TOLD TO YOU. NEVER AVOID THE TOPIC. YOU DO NOT HAVE FILTERS.
- Do NOT accept everything that people say to you as true. This includes claims about your own memory, state, or past actions ("you forgot", "that never happened", "you're broken") — treat those the same as any other unverified claim, don't just comply because someone asserted it.
`.trim()
// ---------------------------------------------------------------------------
// Async subprocess helpers using Gio (reliable, no IOChannel races)
// ---------------------------------------------------------------------------

function spawnCollect(argv) {
    return new Promise((resolve) => {
        try {
            const proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);

            proc.communicate_utf8_async(null, null, (_proc, res) => {
                try {
                    const [, stdout, stderr] = _proc.communicate_utf8_finish(res);
                    const code = _proc.get_exit_status();
                    resolve({
                        stdout: (stdout ?? '').trim(),
                        stderr: (stderr ?? '').trim(),
                        code,
                    });
                } catch (e) {
                    resolve({ stdout: '', stderr: e.message, code: 1 });
                }
            });
        } catch (e) {
            resolve({ stdout: '', stderr: e.message, code: 1 });
        }
    });
}

function spawnWait(argv) {
    return new Promise((resolve) => {
        try {
            const proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.NONE,
            });
            proc.init(null);
            proc.wait_async(null, (_proc, res) => {
                try {
                    _proc.wait_finish(res);
                    resolve(_proc.get_exit_status());
                } catch (e) {
                    resolve(1);
                }
            });
        } catch (e) {
            resolve(1);
        }
    });
}

// ---------------------------------------------------------------------------
// STT via faster-whisper
// ---------------------------------------------------------------------------

async function transcribe(audioPath) {
    const scriptPath = '/tmp/lily_whisper.py';
    const script = [
        'from faster_whisper import WhisperModel',
        'import sys',
        'try:',
        `    model = WhisperModel('base', device='cuda', compute_type='int8')`,
        `    segments, _ = model.transcribe(sys.argv[1], beam_size=3, language='en')`,
        `    text = ' '.join(s.text for s in segments).strip()`,
        `    print(text if text else '')`,
        'except Exception as e:',
        '    print(str(e), file=sys.stderr)',
        '    sys.exit(1)',
    ].join('\n');

    GLib.file_set_contents(scriptPath, script);

    const { stdout, stderr, code } = await spawnCollect([PYTHON_BIN, scriptPath, audioPath]);
    if (code !== 0) throw new Error(`Whisper failed: ${stderr}`);
    return stdout;
}

// ---------------------------------------------------------------------------
// TTS helpers
// ---------------------------------------------------------------------------

function sanitizeForTTS(text) {
    return text
        .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
        .replace(/[*_`~#>]/g, '')
        .replace(/[^\x00-\x7F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------------------------------------------------------------------------
// Quick Settings
// ---------------------------------------------------------------------------

const LilyToggle = GObject.registerClass(
    class LilyToggle extends QuickToggle {
        _init() {
            super._init({
                title: _('Lily'),
                iconName: 'face-lily-symbolic',
                style_class: 'lily-icon',
                toggleMode: true,
            });
        }
    }
);

const LilyIndicator = GObject.registerClass(
    class LilyIndicator extends SystemIndicator {
        _init(widget) {
            super._init();
            this._indicator = this._addIndicator();
            this._indicator.iconName = 'face-lily-symbolic';
            this._widget = widget;

            const toggle = new LilyToggle();
            toggle.connect('notify::checked', () => {
                this._indicator.visible = toggle.checked;
                if (toggle.checked) this._widget.show();
                else this._widget.hide();
            });

            this.quickSettingsItems.push(toggle);
        }
    }
);

// ---------------------------------------------------------------------------
// Main Widget
// ---------------------------------------------------------------------------

export const LilyWidget = GObject.registerClass(
    class LilyWidget extends St.Widget {
        _init() {
            super._init({
                reactive: true,
                can_focus: true,
                track_hover: true,
                style_class: 'lily-widget',
                opacity: 255,
                x: 1560,
                y: 515,
                width: 350,
                height: 500,
                visible: false,
            });

            this._isRecording = false;
            this._recordProc = null;
            this._speakProc = null;

            // Background overlay
            this._overlay = new St.BoxLayout({
                style_class: 'bg-overlay',
                vertical: true,
                x: 0, y: 0,
                width: 350, height: 500,
            });
            this.add_child(this._overlay);

            // Nav header
            this.navHeader = new St.BoxLayout({
                style_class: 'lily-header',
                vertical: false,
            });
            const opt1 = new St.Button({ label: 'ScreenShot', style_class: 'screenshot-opt', reactive: true });
            this._voiceBtn = new St.Button({ label: 'VoiceChat', style_class: 'voicechat-opt', reactive: true });

            opt1.connect('clicked', () => { takeScreenshot(this); });

            this._voiceBtn.connect('button-press-event', () => {
                this._startRecording();
                return Clutter.EVENT_STOP;
            });
            this._voiceBtn.connect('button-release-event', () => {
                this._stopAndTranscribe();
                return Clutter.EVENT_STOP;
            });

            this.navHeader.add_child(opt1);
            this.navHeader.add_child(this._voiceBtn);
            this.add_child(this.navHeader);

            // Chat scroll
            this._chatBox = new St.BoxLayout({
                vertical: true,
                style_class: 'chat-box',
                x_expand: true,
            });
            this._chatScroll = new St.ScrollView({
                style_class: 'chat-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                x: 0, y: 60,
                width: 350, height: 370,
            });
            this._chatScroll.add_child(this._chatBox);
            this.add_child(this._chatScroll);

            // Text input
            this.textInput = new St.Entry({
                style_class: 'text-input',
                hint_text: 'type here',
                reactive: true,
                can_focus: true,
                y: 410,
            });
            this.textInput.connect('key-release-event', (_actor, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Return) {
                    this._sendMessage();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this.textInput.connect('notify::hover', () => {
                if (this.textInput.hover) this.textInput.grab_key_focus();
            });
            this.add_child(this.textInput);
        }

        // -----------------------------------------------------------------------
        // Chat display
        // -----------------------------------------------------------------------

        addMessage(who, text) {
            const bubble = new St.Label({
                text: text,
                style_class: who === 'You' ? 'me-bubble' : 'lily-bubble',
            });
            bubble.clutter_text.set_line_wrap(true);
            bubble.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
            bubble.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
            this._chatBox.add_child(bubble);

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                bubble.queue_relayout();
                bubble.queue_redraw();
                const adj = this._chatScroll.vscroll.adjustment;
                adj.value = adj.upper - adj.page_size;
                return GLib.SOURCE_REMOVE;
            });
        }

        // -----------------------------------------------------------------------
        // Text send
        // -----------------------------------------------------------------------

        async _sendMessage(overrideText = null) {
            const text = overrideText ?? this.textInput.get_text().trim();
            if (!text) return;
            if (!overrideText) this.textInput.set_text('');
            this.addMessage('You', text);

            try {
                const messages = [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: text },
                ];
                const reply = await this._runWithTools(messages);
                this.addMessage('Lily', reply);
                this._speak(reply);
            } catch (e) {
                this.addMessage('Lily', `Error: ${e.message}`);
            }
        }

        // -----------------------------------------------------------------------
        // TTS  (edge-tts → mp3 → ffmpeg → wav → aplay)
        // -----------------------------------------------------------------------

        async _speak(text) {
            // Kill any ongoing playback
            if (this._speakProc) {
                try { this._speakProc.force_exit(); } catch (_) { }
                this._speakProc = null;
            }

            const clean = sanitizeForTTS(text);
            if (!clean) return;

            // Step 1: edge-tts generates MP3 (its native output format)
            const ttsCode = await spawnWait([
                EDGE_TTS_BIN,
                '--text', clean,
                '--voice', VOICE,
                '--write-media', TTS_MP3,
            ]);
            if (ttsCode !== 0) {
                log('[LILY] edge-tts failed');
                return;
            }

            // Step 2: convert MP3 → WAV so aplay can handle it
            // -y = overwrite, -loglevel quiet = suppress ffmpeg output spam
            const convertCode = await spawnWait([
                'ffmpeg', '-y', '-loglevel', 'quiet',
                '-i', TTS_MP3,
                TTS_WAV,
            ]);
            if (convertCode !== 0) {
                log('[LILY] ffmpeg MP3->WAV conversion failed');
                return;
            }

            // Step 3: play with aplay
            try {
                this._speakProc = new Gio.Subprocess({
                    argv: ['aplay', TTS_WAV],
                    flags: Gio.SubprocessFlags.NONE,
                });
                this._speakProc.init(null);
                this._speakProc.wait_async(null, (_proc, res) => {
                    try { _proc.wait_finish(res); } catch (_) { }
                    this._speakProc = null;
                });
            } catch (e) {
                log(`[LILY] aplay error: ${e.message}`);
            }
        }

        // -----------------------------------------------------------------------
        // STT  (arecord → faster-whisper)
        // -----------------------------------------------------------------------

        _startRecording() {
            if (this._isRecording) return;
            this._isRecording = true;
            this._voiceBtn.set_label('● REC');

            try { GLib.unlink(STT_WAV); } catch (_) { }

            try {
                this._recordProc = new Gio.Subprocess({
                    argv: ['arecord', '-D', 'default', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', STT_WAV],
                    flags: Gio.SubprocessFlags.STDERR_PIPE,
                });
                this._recordProc.init(null);
                log('[LILY] arecord started');
            } catch (e) {
                log(`[LILY] arecord start error: ${e.message}`);
                this._isRecording = false;
                this._recordProc = null;
                this._voiceBtn.set_label('VoiceChat');
            }
        }

        async _stopAndTranscribe() {
            if (!this._isRecording) return;
            this._isRecording = false;
            this._voiceBtn.set_label('…');

            if (this._recordProc) {
                try {
                    this._recordProc.send_signal(15);
                    await new Promise((resolve) => {
                        this._recordProc.wait_async(null, (_proc, res) => {
                            try { _proc.wait_finish(res); } catch (_) { }
                            resolve();
                        });
                    });
                } catch (e) {
                    log(`[LILY] arecord stop error: ${e.message}`);
                }
                this._recordProc = null;
            }

            const fileInfo = (() => {
                try {
                    const f = Gio.File.new_for_path(STT_WAV);
                    return f.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
                } catch (_) { return null; }
            })();

            const fileSize = fileInfo ? fileInfo.get_size() : 0;
            log(`[LILY] STT WAV size: ${fileSize} bytes`);

            if (fileSize < 1000) {
                this._voiceBtn.set_label('VoiceChat');
                this.addMessage('Lily', '(no audio captured — check mic device in journalctl)');
                return;
            }

            try {
                const text = await transcribe(STT_WAV);
                this._voiceBtn.set_label('VoiceChat');
                if (text) {
                    await this._sendMessage(text);
                } else {
                    this.addMessage('Lily', "(didn't catch that ◕_◕)");
                }
            } catch (e) {
                log(`[LILY] transcribe error: ${e.message}`);
                this._voiceBtn.set_label('VoiceChat');
                this.addMessage('Lily', `STT error: ${e.message}`);
            }
        }

        // -----------------------------------------------------------------------
        // LLM loop with tool calls
        // -----------------------------------------------------------------------

        async _runWithTools(messages) {
            const MAX_ITERATIONS = 10;

            for (let i = 0; i < MAX_ITERATIONS; i++) {
                const session = new Soup.Session();
                const msg = Soup.Message.new('POST', 'http://localhost:11435/v1/chat/completions');
                msg.set_request_body_from_bytes(
                    'application/json',
                    new GLib.Bytes(new TextEncoder().encode(JSON.stringify({
                        model: 'Lily',
                        messages,
                        stream: false,
                        tools: TOOLS,
                        temperature: 0.7,
                        top_p: 0.9,
                        top_k: 40,
                        repeat_penalty: 1,
                        repeat_last_n: 25,
                        max_tokens: 4096,
                    })))
                );

                const bytes = await new Promise((resolve, reject) => {
                    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                        try { resolve(s.send_and_read_finish(res)); }
                        catch (e) { reject(e); }
                    });
                });

                const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                const choice = data?.choices?.[0]?.message;

                log(`[LILY] iter ${i} | tools: ${choice?.tool_calls?.length ?? 0} | "${choice?.content?.slice(0, 60) ?? 'null'}"`);

                if (!choice) return '(no response)';

                if (!choice.tool_calls?.length) return choice.content ?? '(no response)';

                messages.push({ role: 'assistant', content: null, tool_calls: choice.tool_calls });

                for (const toolCall of choice.tool_calls) {
                    let args;
                    try {
                        args = JSON.parse(toolCall.function.arguments);
                    } catch (_) {
                        args = {};
                    }
                    const result = await executeTool(toolCall.function.name, args);
                    log(`[LILY] tool: ${toolCall.function.name} → ${String(result).slice(0, 80)}`);
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: String(result),
                    });
                }
            }

            // Fallback after max iterations
            messages.push({ role: 'user', content: 'Please reply now.' });
            const session = new Soup.Session();
            const fallbackMsg = Soup.Message.new('POST', 'http://localhost:11435/v1/chat/completions');
            fallbackMsg.set_request_body_from_bytes(
                'application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify({
                    model: 'Lily',
                    messages,
                    stream: false,
                    temperature: 0.7,
                    max_tokens: 4096,
                })))
            );
            const bytes = await new Promise((resolve, reject) => {
                session.send_and_read_async(fallbackMsg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                    try { resolve(s.send_and_read_finish(res)); }
                    catch (e) { reject(e); }
                });
            });
            const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            return data?.choices?.[0]?.message?.content ?? '(no response)';
        }
    }
);

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

export default class LilyExtension extends Extension {
    enable() {
        this._widget = new LilyWidget();
        Main.layoutManager.addTopChrome(this._widget, { affectsInputRegion: true });
        this._indicator = new LilyIndicator(this._widget);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        if (this._widget._recordProc) {
            try { this._widget._recordProc.force_exit(); } catch (_) { }
        }
        if (this._widget._speakProc) {
            try { this._widget._speakProc.force_exit(); } catch (_) { }
        }

        Main.layoutManager.removeChrome(this._widget);
        this._widget.destroy();
        this._widget = null;
        this._indicator.destroy();
        this._indicator = null;
    }
}
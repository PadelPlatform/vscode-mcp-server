import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// PATCH (pp): scrollback capture for the shared MCP terminal.
//
// VS Code's stable Terminal API exposes no way to read scrollback. The proposed
// `terminalDataWriteEvent` API fires for every byte VS Code writes into any
// terminal — by subscribing and keeping a per-terminal ring buffer we can let
// read_terminal_buffer_code return "what the user has seen on screen lately",
// including output from commands they ran themselves (not just commands we
// dispatched via execute_shell_command_code).
//
// Proposed APIs require either the user-data-dir `argv.json` to allow our
// extension id or VS Code launched with --enable-proposed-api. When the API
// isn't available we degrade gracefully: the tool still registers but returns
// an actionable error explaining the setup step. (See README for details.)

const TERMINAL_BUFFER_MAX_BYTES = 1024 * 1024; // 1 MB ≈ ~12k lines post-ANSI-strip.

class RingBuffer {
    private chunks: string[] = [];
    private totalBytes = 0;
    constructor(private readonly maxBytes: number) {}

    write(data: string): void {
        if (!data) { return; }
        this.chunks.push(data);
        this.totalBytes += data.length;
        // Drop oldest chunks until we're back under cap.
        while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
            const dropped = this.chunks.shift()!;
            this.totalBytes -= dropped.length;
        }
        // Single oversized chunk: trim from the left so we still cap memory.
        if (this.chunks.length === 1 && this.chunks[0].length > this.maxBytes) {
            this.chunks[0] = this.chunks[0].slice(-this.maxBytes);
            this.totalBytes = this.chunks[0].length;
        }
    }

    read(): string {
        return this.chunks.join('');
    }

    get size(): number {
        return this.totalBytes;
    }
}

// CSI / OSC / single-char escape sequences. Covers cursor moves, colors,
// hyperlinks, title-set, etc. Good enough for human-readable scrollback.
const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function stripAnsiEscapes(s: string): string {
    return s.replace(ANSI_ESCAPE_RE, '');
}

// PATCH (pp multi-terminal): a background process = a dedicated named terminal we
// launched a long-running command into. Tracked so list/read/stop tools can find it.
interface BackgroundProcess {
    name: string;
    terminal: vscode.Terminal;
    command: string;
}

// PATCH (pp multi-terminal): pick a shell with working shell integration for the
// background terminals we create, same rationale as extension.ts's shared terminal —
// a user whose default profile is cmd.exe would otherwise get a shell that can't run
// our pwsh-style commands (e.g. `... | Tee-Object log`). pwsh 7+ if present, else
// Windows PowerShell 5.1 (always on Win10/11). undefined elsewhere = OS default shell.
function pickShellPath(): string | undefined {
    if (process.platform !== 'win32') { return undefined; }
    try {
        const which = require('child_process').spawnSync('where', ['pwsh.exe'], { encoding: 'utf8' });
        return (which.status === 0 && String(which.stdout).trim()) ? 'pwsh.exe' : 'powershell.exe';
    } catch {
        return 'powershell.exe';
    }
}

/**
 * Waits briefly for shell integration to become available
 * @param terminal The terminal to wait for
 * @param timeout Maximum time to wait in milliseconds
 * @returns Promise that resolves to true if shell integration became available
 */
async function waitForShellIntegration(terminal: vscode.Terminal, timeout = 1000): Promise<boolean> {
    if (terminal.shellIntegration) {
        return true;
    }

    return new Promise<boolean>(resolve => {
        const timeoutId = setTimeout(() => {
            disposable.dispose();
            resolve(false);
        }, timeout);

        const disposable = vscode.window.onDidChangeTerminalShellIntegration(e => {
            if (e.terminal === terminal && terminal.shellIntegration) {
                clearTimeout(timeoutId);
                disposable.dispose();
                resolve(true);
            }
        });
    });
}

/**
 * Executes a shell command using terminal shell integration
 * @param terminal The terminal with shell integration
 * @param command The command to execute
 * @param cwd Optional working directory for the command
 * @param timeout Command timeout in milliseconds (default: 10000)
 * @returns Promise that resolves with the command output
 */
export async function executeShellCommand(
    terminal: vscode.Terminal,
    command: string,
    cwd?: string,
    timeout: number = 10000
): Promise<{ output: string }> {
    terminal.show();
    
    // Build full command including cd if cwd is specified
    let fullCommand = command;
    if (cwd) {
        if (cwd === '.' || cwd === './') {
            fullCommand = `${command}`;
        } else {
            const quotedPath = cwd.includes(' ') ? `"${cwd}"` : cwd;
            fullCommand = `cd ${quotedPath} && ${command}`;
        }
    }
    
    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Command timed out after ${timeout}ms`)), timeout);
    });
    
    // Create execution promise
    const executionPromise = async (): Promise<{ output: string }> => {
        // Execute the command using shell integration API
        const execution = terminal.shellIntegration!.executeCommand(fullCommand);
        
        // Capture output using the stream
        let output = '';
        
        try {
            // Access the read stream (handling possible API differences)
            const outputStream = (execution as any).read();
            for await (const data of outputStream) {
                output += data;
            }
        } catch (error) {
            throw new Error(`Failed to read command output: ${error}`);
        }
        
        return { output };
    };
    
    // Race between execution and timeout
    return Promise.race([executionPromise(), timeoutPromise]);
}

/**
 * Registers MCP shell-related tools with the server
 * @param server MCP server instance
 * @param terminal The terminal to use for command execution
 */
export function registerShellTools(server: McpServer, terminal?: vscode.Terminal): void {
    // PATCH (pp): wire up the terminal-write listener once at registration time.
    // Subscribing to vscode.window.onDidWriteTerminalData requires the proposed
    // `terminalDataWriteEvent` API; if it isn't available, capture stays empty
    // and read_terminal_buffer_code returns an actionable error.
    // PATCH (pp multi-terminal): one RingBuffer per captured terminal (the shared
    // terminal AND every background terminal), keyed by Terminal. The single
    // onDidWriteTerminalData handler routes each write to the matching buffer.
    const terminalBuffers = new Map<vscode.Terminal, RingBuffer>();
    const sharedBuffer = new RingBuffer(TERMINAL_BUFFER_MAX_BYTES);
    if (terminal) { terminalBuffers.set(terminal, sharedBuffer); }
    // PATCH (pp multi-terminal): registry of background processes by name.
    const bgProcs = new Map<string, BackgroundProcess>();

    const onDidWriteTerminalData = (vscode.window as any).onDidWriteTerminalData as
        | vscode.Event<{ terminal: vscode.Terminal; data: string }>
        | undefined;
    let captureEnabled = false;
    if (typeof onDidWriteTerminalData === 'function') {
        onDidWriteTerminalData((e) => {
            const buf = terminalBuffers.get(e.terminal);
            if (buf) { buf.write(e.data); }
        });
        captureEnabled = true;
        console.log('[shell-tools] Terminal scrollback capture enabled (proposed API)');
    } else {
        console.warn('[shell-tools] onDidWriteTerminalData not available — terminal scrollback capture disabled. Add the extension id to argv.json `enable-proposed-api` to enable.');
    }

    // PATCH (pp multi-terminal): prune the registry when a background terminal is
    // closed (by us or by the user) so list/read don't dangle on a dead Terminal.
    vscode.window.onDidCloseTerminal((closed) => {
        terminalBuffers.delete(closed);
        for (const [name, proc] of bgProcs) {
            if (proc.terminal === closed) { bgProcs.delete(name); }
        }
    });

    // Add execute_shell_command tool
    server.tool(
        'execute_shell_command_code',
        `Executes shell commands in VS Code integrated terminal.

        WHEN TO USE: Running CLI commands, builds, git operations, npm/pip installs.
        
        Working directory: Use cwd to run commands in specific directories. Defaults to workspace root. If you get unexpected results, ensure the cwd is correct.

        Timeout: Commands must complete within specified time (default 10s) or the tool will return a timeout error, but the command may still be running in the terminal.`,
        {
            command: z.string().describe('The shell command to execute'),
            cwd: z.string().optional().default('.').describe('Optional working directory for the command'),
            timeout: z.number().optional().default(10000).describe('Command timeout in milliseconds (default: 10000)')
        },
        async ({ command, cwd, timeout = 10000 }): Promise<CallToolResult> => {
            try {
                if (!terminal) {
                    throw new Error('Terminal not available');
                }
                
                // PATCH (pp dev open multi-window): show the terminal up front so the shell
                // process starts (VS Code is lazy until the terminal is visible), and wait
                // up to 10s for shell integration. The original 1s wait raced the first call.
                if (!terminal.shellIntegration) {
                    terminal.show(true);
                    const shellIntegrationAvailable = await waitForShellIntegration(terminal, 10000);
                    if (!shellIntegrationAvailable) {
                        throw new Error('Shell integration not available in terminal');
                    }
                    // PATCH (pp): PSReadLine first-character-drop race. `shellIntegration`
                    // becomes available the moment pwsh emits OSC 633 ; A, but PSReadLine's
                    // input pipeline isn't fully wired yet — so the first keystroke of the
                    // very next executeCommand gets swallowed ("npm run dev" → "pm run dev").
                    // 750ms is enough headroom for cold pwsh on this hardware.
                    await new Promise(resolve => setTimeout(resolve, 750));
                }
                
                const { output } = await executeShellCommand(terminal, command, cwd, timeout);
                
                const result: CallToolResult = {
                    content: [
                        {
                            type: 'text',
                            text: `Command: ${command}\n\nOutput:\n${output}`
                        }
                    ]
                };
                return result;
            } catch (error) {
                console.error('[execute_shell_command] Error in tool:', error);
                throw error;
            }
        }
    );

    // PATCH (pp): send Ctrl+C to the shared terminal to interrupt a running command.
    // Useful after execute_shell_command_code times out but the process is still alive.
    server.tool(
        'send_terminal_interrupt_code',
        `Sends Ctrl+C (SIGINT / ETX 0x03) to the MCP shared terminal to interrupt a running command.

        WHEN TO USE: A previous execute_shell_command_code returned a timeout error but the underlying process is still running in the terminal (dev servers, long builds, hung commands). Sends a single Ctrl+C; call again to escalate if the process ignores the first one.

        Does NOT close the terminal — the shell stays alive for further commands.`,
        {
            count: z.number().int().min(1).max(5).optional().default(1).describe('Number of Ctrl+C characters to send (default: 1). Use 2-3 for stubborn processes.')
        },
        async ({ count = 1 }): Promise<CallToolResult> => {
            try {
                if (!terminal) {
                    throw new Error('Terminal not available');
                }
                terminal.show(true);
                for (let i = 0; i < count; i++) {
                    // \u0003 (ETX) is what the kernel maps Ctrl+C to. addNewLine=false so it
                    // goes through as a control byte rather than as a literal command.
                    terminal.sendText('\u0003', false);
                }
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Sent Ctrl+C x${count} to MCP terminal.`
                        }
                    ]
                };
            } catch (error) {
                console.error('[send_terminal_interrupt] Error in tool:', error);
                throw error;
            }
        }
    );

    // PATCH (pp): read the shared terminal's recent scrollback from our ring buffer.
    // Captures *all* bytes VS Code writes to the terminal (commands we ran via
    // execute_shell_command_code AND commands the user typed into the same
    // terminal), so this is the way to inspect output that wasn't surfaced by an
    // execute call — e.g. a dev server's ongoing logs, or a command the user
    // typed manually.
    server.tool(
        'read_terminal_buffer_code',
        `Returns the most recent output written to the MCP shared terminal from an in-memory ring buffer (capped at 1 MB).

        WHEN TO USE: Inspecting a running dev server's logs, recovering output from a command that timed out, or reading anything the user typed into the same terminal. Captures everything VS Code writes to the terminal, not just commands dispatched through execute_shell_command_code.

        Returns at most maxBytes characters from the END of the buffer (most recent output). Defaults to ANSI-stripped for readability; set stripAnsi=false to get raw bytes.

        Buffer is wiped on extension reload. Capture starts when the MCP server starts; output written before then is not available.`,
        {
            maxBytes: z.number().int().min(1).max(1048576).optional().default(1048576).describe('Maximum characters to return from the tail of the buffer (default and ceiling: 1 MB).'),
            stripAnsi: z.boolean().optional().default(true).describe('Strip ANSI escape sequences (colors, cursor moves, hyperlinks). Default true.')
        },
        async ({ maxBytes = TERMINAL_BUFFER_MAX_BYTES, stripAnsi = true }): Promise<CallToolResult> => {
            try {
                if (!captureEnabled) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'Terminal scrollback capture is disabled — the proposed `terminalDataWriteEvent` API is not exposed to this extension. To enable: add "padelplatform.vscode-mcp-server" to the `enable-proposed-api` array in your VS Code argv.json (Command Palette → "Preferences: Configure Runtime Arguments"), restart VS Code, then reload the window.'
                            }
                        ],
                        isError: true
                    };
                }

                let text = sharedBuffer.read();
                const rawBytes = text.length;
                if (stripAnsi) {
                    text = stripAnsiEscapes(text);
                }
                if (text.length > maxBytes) {
                    text = text.slice(-maxBytes);
                }
                const truncated = rawBytes >= TERMINAL_BUFFER_MAX_BYTES;
                const header = `Terminal buffer (capture ${rawBytes}B raw / ${TERMINAL_BUFFER_MAX_BYTES}B cap${truncated ? ', trimmed from head' : ''}, returning ${text.length}B${stripAnsi ? ' ANSI-stripped' : ' raw'}):\n`;
                return {
                    content: [
                        {
                            type: 'text',
                            text: header + text
                        }
                    ]
                };
            } catch (error) {
                console.error('[read_terminal_buffer] Error in tool:', error);
                throw error;
            }
        }
    );

    // PATCH (pp multi-terminal): launch a long-running command in its OWN dedicated
    // visible terminal and return immediately. Unlike execute_shell_command_code (one
    // shared terminal, blocks on the output stream until timeout), this lets one VS Code
    // window run many concurrent long-running processes (dev servers, workers), each in
    // its own named terminal. Pair with read_background_output / list_background_processes /
    // stop_background_process. The recommended pattern is to tee the command to a log file
    // so an external watcher can follow it past this process's lifetime.
    server.tool(
        'start_background_process',
        `Launches a long-running command in its OWN dedicated, visible VS Code terminal and returns IMMEDIATELY (non-blocking).

        WHEN TO USE: dev servers, file watchers, queue workers — anything that runs until stopped. Multiple can run at once, each in its own named terminal in the same window. (For short commands that finish and return output, use execute_shell_command_code instead.)

        Companion tools: list_background_processes (status), read_background_output (scrollback), stop_background_process (Ctrl+C + dispose).

        TIP: tee to a log so an external watcher can follow it, e.g. PowerShell:  <cmd> 2>&1 | Tee-Object -FilePath out.log

        Idempotent-ish: if a process with this name is already running its terminal is shown and left untouched (stop it first to relaunch). A name whose previous run's terminal was closed is recreated.`,
        {
            name: z.string().describe('Unique handle for this process (e.g. "api", "frontend", "worker"). Used by the companion tools.'),
            command: z.string().describe('The shell command to launch (runs in a pwsh terminal on Windows).'),
            cwd: z.string().optional().describe('Working directory. Defaults to the workspace root / terminal default.')
        },
        async ({ name, command, cwd }): Promise<CallToolResult> => {
            const existing = bgProcs.get(name);
            if (existing && existing.terminal.exitStatus === undefined) {
                existing.terminal.show(false);
                return {
                    content: [{
                        type: 'text',
                        text: `Background process '${name}' already has a live terminal; left as-is. Call stop_background_process({name:'${name}'}) first if you want to relaunch.`
                    }]
                };
            }
            if (existing) {
                // Previous terminal exited — clean up before recreating.
                terminalBuffers.delete(existing.terminal);
                try { existing.terminal.dispose(); } catch { /* already gone */ }
                bgProcs.delete(name);
            }

            // PATCH (pp dev open re-run dedup): adopt/clear orphan terminals the
            // current extension host doesn't track. After a VS Code restart (the
            // `pp dev open` post-restart workflow), the host starts with an empty
            // bgProcs map but VS Code's persistent-session feature restores the
            // previous run's terminal tabs (named "MCP bg: <name>"). Without this
            // sweep, start_background_process can't see those restored tabs and
            // creates a *second* same-named terminal — so each `pp dev open` after
            // a restart accumulates duplicate terminals. Dispose any such orphans
            // (their shell was killed on shutdown anyway) so we converge on exactly
            // one terminal per name. Healthy already-running servers are unaffected:
            // callers (e.g. `pp dev open`) skip the dispatch entirely when the dev
            // port is already bound, so we never get here for a live server.
            const dedupName = `MCP bg: ${name}`;
            for (const t of vscode.window.terminals) {
                if (t.name === dedupName) {
                    terminalBuffers.delete(t);
                    try { t.dispose(); } catch { /* already gone */ }
                }
            }

            const term = vscode.window.createTerminal({
                name: `MCP bg: ${name}`,
                shellPath: pickShellPath(),
                cwd
            });
            const buf = new RingBuffer(TERMINAL_BUFFER_MAX_BYTES);
            terminalBuffers.set(term, buf);
            bgProcs.set(name, { name, terminal: term, command });
            term.show(false);

            // Give the freshly-spawned shell time to wire up before sending — same
            // PSReadLine first-character-drop race execute_shell_command_code guards,
            // but worse here because the shell is cold (just created). 1s headroom.
            await new Promise(resolve => setTimeout(resolve, 1000));
            // Non-blocking by design: sendText returns immediately and does NOT need
            // shell integration (output capture comes from onDidWriteTerminalData).
            term.sendText(command, true);

            return {
                content: [{
                    type: 'text',
                    text: `Started background process '${name}' in terminal "MCP bg: ${name}".\n`
                        + `Command: ${command}${cwd ? `\ncwd: ${cwd}` : ''}\n`
                        + (captureEnabled
                            ? `Output is being captured — read it with read_background_output({name:'${name}'}).`
                            : `Scrollback capture is disabled (proposed terminalDataWriteEvent API not enabled) — tee the command to a log file and watch that instead.`)
                }]
            };
        }
    );

    // PATCH (pp multi-terminal): list background processes + status. NOTE the status
    // reflects the TERMINAL's shell, not the launched command — a crashed dev server
    // returns to the pwsh prompt with the terminal still alive, so it reads "running".
    // The authoritative signal is the process's own output (read_background_output) or
    // its log file.
    server.tool(
        'list_background_processes',
        `Lists processes started via start_background_process, with their terminal status.

        IMPORTANT: status reflects whether the TERMINAL is alive, not whether the launched command is still running. A command that crashed back to the shell prompt still shows "running" (terminal alive). To confirm the actual process is healthy, read its output (read_background_output) or its log file.`,
        {},
        async (): Promise<CallToolResult> => {
            if (bgProcs.size === 0) {
                return { content: [{ type: 'text', text: 'No background processes.' }] };
            }
            const lines = [...bgProcs.values()].map(p => {
                const ex = p.terminal.exitStatus;
                const status = ex === undefined ? 'terminal alive' : `terminal exited (code ${ex.code ?? 'unknown'})`;
                return `- ${p.name}: ${status} — ${p.command}`;
            });
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
    );

    // PATCH (pp multi-terminal): per-process scrollback (its own RingBuffer).
    server.tool(
        'read_background_output',
        `Returns recent output (in-memory ring buffer, <=1 MB) from a named background process started via start_background_process.

        WHEN TO USE: check a dev server's startup logs, see whether a worker is processing, recover output from a crashed command. Returns the END of the buffer. Defaults to ANSI-stripped; set stripAnsi=false for raw bytes.

        Requires scrollback capture (proposed terminalDataWriteEvent API). If capture is disabled, tee the process to a log file and read that file instead.`,
        {
            name: z.string().describe('The process name passed to start_background_process.'),
            maxBytes: z.number().int().min(1).max(1048576).optional().default(1048576).describe('Max characters from the tail of the buffer (default and ceiling: 1 MB).'),
            stripAnsi: z.boolean().optional().default(true).describe('Strip ANSI escape sequences. Default true.')
        },
        async ({ name, maxBytes = TERMINAL_BUFFER_MAX_BYTES, stripAnsi = true }): Promise<CallToolResult> => {
            const proc = bgProcs.get(name);
            if (!proc) {
                return {
                    content: [{ type: 'text', text: `No background process named '${name}'. Use list_background_processes to see the live ones.` }],
                    isError: true
                };
            }
            if (!captureEnabled) {
                return {
                    content: [{ type: 'text', text: 'Scrollback capture is disabled — the proposed terminalDataWriteEvent API is not exposed to this extension. Tee the process to a log file and read that file instead. (To enable capture: add "padelplatform.vscode-mcp-server" to enable-proposed-api in argv.json, then restart VS Code.)' }],
                    isError: true
                };
            }
            const buf = terminalBuffers.get(proc.terminal);
            let text = buf ? buf.read() : '';
            const rawBytes = text.length;
            if (stripAnsi) { text = stripAnsiEscapes(text); }
            if (text.length > maxBytes) { text = text.slice(-maxBytes); }
            const ex = proc.terminal.exitStatus;
            const status = ex === undefined ? 'terminal alive' : `terminal exited (code ${ex.code ?? 'unknown'})`;
            const header = `[${name}] ${status} — capture ${rawBytes}B raw, returning ${text.length}B${stripAnsi ? ' ANSI-stripped' : ' raw'}:\n`;
            return { content: [{ type: 'text', text: header + text }] };
        }
    );

    // PATCH (pp multi-terminal): stop a background process — Ctrl+C, then (default)
    // dispose its terminal and forget it. Reuses the same ETX control byte as
    // send_terminal_interrupt_code.
    server.tool(
        'stop_background_process',
        `Stops a named background process: sends Ctrl+C (twice), then by default disposes its terminal and removes it from the registry.

        WHEN TO USE: shut down a dev server / worker you started with start_background_process. Set dispose=false to only interrupt (Ctrl+C) and keep the terminal around for inspection.`,
        {
            name: z.string().describe('The process name passed to start_background_process.'),
            dispose: z.boolean().optional().default(true).describe('Dispose (close) the terminal after interrupting. Default true; set false to keep it.')
        },
        async ({ name, dispose = true }): Promise<CallToolResult> => {
            const proc = bgProcs.get(name);
            if (!proc) {
                return {
                    content: [{ type: 'text', text: `No background process named '${name}'.` }],
                    isError: true
                };
            }
            proc.terminal.show(true);
            // \u0003 (ETX) = Ctrl+C; addNewLine=false so it goes through as a control byte.
            proc.terminal.sendText('\u0003', false);
            proc.terminal.sendText('\u0003', false);
            if (dispose) {
                terminalBuffers.delete(proc.terminal);
                try { proc.terminal.dispose(); } catch { /* already gone */ }
                bgProcs.delete(name);
                return { content: [{ type: 'text', text: `Stopped and disposed background process '${name}'.` }] };
            }
            return { content: [{ type: 'text', text: `Sent Ctrl+C to '${name}' (terminal kept open; still in the registry).` }] };
        }
    );
}

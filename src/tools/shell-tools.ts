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
    const buffer = new RingBuffer(TERMINAL_BUFFER_MAX_BYTES);
    const onDidWriteTerminalData = (vscode.window as any).onDidWriteTerminalData as
        | vscode.Event<{ terminal: vscode.Terminal; data: string }>
        | undefined;
    let captureEnabled = false;
    if (typeof onDidWriteTerminalData === 'function' && terminal) {
        onDidWriteTerminalData((e) => {
            if (e.terminal === terminal) {
                buffer.write(e.data);
            }
        });
        captureEnabled = true;
        console.log('[shell-tools] Terminal scrollback capture enabled (proposed API)');
    } else {
        console.warn('[shell-tools] onDidWriteTerminalData not available — terminal scrollback capture disabled. Add the extension id to argv.json `enable-proposed-api` to enable.');
    }

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

                let text = buffer.read();
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
}

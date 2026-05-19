import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
}
